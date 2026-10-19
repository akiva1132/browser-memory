/**
 * What the server tells the agent once, at connect, outside its reach.
 *
 * Separate from the brief because the two are different kinds of claim. A brief
 * is what earlier agents found out about one site and may be wrong; this is the
 * contract. It started life as a seeded lesson in the global scope, where it
 * was ranked against site trivia, `domain_curate` could propose deleting it,
 * and `trust()` would eventually mark it stale — a founding invariant decaying
 * like a tip about a date format.
 */
import { ENV_SCOPE, GLOBAL_SCOPE } from '../memory/store.ts';
import { apiMap, places, procedures, store } from './context.ts';

/**
 * The server's contract, not a lesson.
 *
 * This started life as a seeded entry in the global memory scope, which was the
 * wrong layer: there it was ranked against site trivia, `domain_curate` could
 * propose deleting it, and `trust()` would eventually mark it stale — a
 * founding invariant decaying like a tip about a date format. MCP has a place
 * for exactly this, delivered once at connect and outside the agent's reach.
 */
export const INSTRUCTIONS =
  'This is a real browser holding the user\'s live, logged-in sessions — the same profile they use ' +
  'themselves. That is the whole premise: no per-service credentials, no connectors to authorize, ' +
  'no separate auth to keep alive.\n\n' +
  'So every action goes through it. To send mail, open the mail site, compose, attach with ' +
  '`browser_file_upload`, and send. To read a calendar, open the calendar. To pay an invoice, open ' +
  'the billing page. Do not reach for a service API, a connector, a CLI or an environment token — ' +
  'if a human would do it in a browser tab, do it in a browser tab.\n\n' +
  'Calling a site\'s own internal endpoints with `browser_evaluate` and `fetch`, from a page already ' +
  'on that site, IS the browser: it rides the same session cookies and is usually far faster than ' +
  'driving the UI. `domain_interface` lists the endpoints each site has been observed calling.\n\n' +
  'Sessions here persist and accumulate. Earlier agents leave behind lessons, procedures and a map ' +
  'of each site\'s API; you are expected to read what is there and add to it.\n\n' +
  'A sign-in is not automatically a dead end. Check `browser_credentials_list` first: if the site is ' +
  'there, `browser_credentials_fill` types the stored username and password into the fields you name ' +
  'and you carry on alone. If a `googleAccount` is stored, use the "Sign in with Google" button and ' +
  'pick that account at the chooser rather than typing anything. Only when nothing is stored do you ' +
  'ask — and then save what you are given with `browser_credentials_save`, so the next agent is not ' +
  'asked the same question. Never repeat a password back in your reply.\n\n' +
  'A CAPTCHA is worth one honest attempt before you escalate. You can see the page, so read the ' +
  'challenge and act on it: tick the box, pick the tiles it names, type the characters. Two failures ' +
  'is the limit — past that you are training their model against yourself, and it is time to ask.\n\n' +
  'What is genuinely not yours: a card number, a two-factor code you have no way to obtain, and a form ' +
  'field whose correct value is not knowable from the page. Call `browser_ask_user` the moment you ' +
  'recognise one, before trying and failing. It raises the tab, reaches the user wherever they are — ' +
  'their client if it can prompt, otherwise their chat app — and returns by itself once they have ' +
  'acted, without them replying. Stopping to ask costs one call; guessing at someone else\'s form is ' +
  'not recoverable.';

/**
 * One line per site that already has something, delivered with the
 * instructions at connect.
 *
 * Everything else about memory is discovered by walking into it: the brief
 * arrives once the agent has already navigated somewhere, which is after it has
 * decided where to go and how. An agent that knows up front which of the sites
 * in its task are already understood can plan around that — reach for the
 * mapped one first, budget for the unmapped one — instead of finding out
 * afterwards.
 *
 * Counts only. The point is to say where to look, not to pay for the contents
 * of every site's memory on every connection.
 */
export const INDEX_LIMIT = 15;

export async function knownSites(): Promise<string> {
  const summaries = await store.index().catch(() => []);
  const lines: string[] = [];
  for (const summary of summaries) {
    // Lessons that hold anywhere are not a site, and listing them as one
    // invites an agent to go and look at `_global`.
    if (summary.domain === GLOBAL_SCOPE || summary.domain === ENV_SCOPE)
      continue;
    const [endpoints, known, saved] = await Promise.all([
      apiMap.forDomain(summary.domain).catch(() => []),
      places.established(summary.domain).catch(() => []),
      procedures.forDomain(summary.domain).catch(() => []),
    ]);
    const parts = [
      `${summary.count} lesson${summary.count === 1 ? '' : 's'}`,
      endpoints.length ? `${endpoints.length} endpoints` : '',
      known.length ? `${known.length} places` : '',
      saved.length ? `${saved.length} procedure${saved.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    lines.push(`- ${summary.domain} — ${parts.join(', ')}`);
  }
  if (!lines.length)
    return '';
  const shown = lines.slice(0, INDEX_LIMIT);
  return `\n\nSites already worked on, so you know before you start which of these you understand:\n\n` +
    `${shown.join('\n')}` +
    `${lines.length > shown.length ? `\n- …and ${lines.length - shown.length} more (\`domain_index\`)` : ''}\n\n` +
    `Those counts are all you get here. \`domain_brief\` is what reads them.`;
}

/**
 * What is true about this machine, said once at connect.
 *
 * These used to sit in `_global`, which meant every site's briefing carried the
 * download directory and the staging path forever. That is not knowledge about
 * any site: an agent arriving at an unfamiliar domain was reading a path on
 * this disk in the same breath as what the domain does. Here they cost tokens
 * once per connection, and they are in front of the agent before its first
 * call rather than after it has already tried the thing they warn about.
 */
export async function environment(): Promise<string> {
  const facts = await store.entries(ENV_SCOPE).catch(() => []);
  const live = facts.filter(entry => !entry.invalidated);
  if (!live.length)
    return '';
  return `\n\nAbout this machine, not about any site:\n\n` +
    `${live.map(entry => `- ${entry.title} — ${entry.gist}`).join('\n')}\n\n` +
    `Record another with \`domain_remember({ url: "_env", … })\`. Site knowledge does not go there.`;
}

