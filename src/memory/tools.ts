import { z } from 'zod';

import {
  GLOBAL_SCOPE, KINDS, KIND_HELP, domainChain, normalizeDomain, trust, trustLabel,
} from './store.ts';
import { matchSymptom, rank } from './recall.ts';
import type { MemoryStore } from './store.ts';
import type { Kind, LocalTool, SourcedLesson } from '../types.ts';

export const sourceLabel = (entry: SourcedLesson, domain: string): string =>
  entry.source === GLOBAL_SCOPE ? ' (applies everywhere)'
    : entry.source === domain ? '' : ` (from ${entry.source})`;

/**
 * @param domain the site being briefed, when there is one.
 *
 *   Without it the heading says only what the lesson is, and a lesson borrowed
 *   from somewhere else looks exactly like one written here. That was fine
 *   while every full rendering was a deliberate `domain_open` on an id the
 *   agent had already seen labelled — and it stopped being fine the moment the
 *   brief started arriving in full, because then this is the *only* place the
 *   label can appear. Caught by the test asserting a global lesson still says
 *   it applies everywhere.
 */
export function renderFull(entry: SourcedLesson, domain?: string): string {
  const from = domain ? sourceLabel(entry, domain) : '';
  const lines = [`## ${entry.kind} — ${entry.title}${from}`, `_${trustLabel(entry)}_`, '', entry.gist];
  if (entry.trigger)
    lines.push('', `**Fires when:** ${entry.trigger}`);
  if (entry.body)
    lines.push('', entry.body);
  if (entry.snippet)
    lines.push('', '```js', entry.snippet, '```');
  lines.push('', `_id: \`${entry.id}\`${entry.source ? ` · from ${entry.source}` : ''}_`);
  return lines.join('\n');
}

export function renderBrief(
  domain: string, entries: SourcedLesson[], ranked: SourcedLesson[], goal?: string,
): string {
  const rows = ranked.map(entry => {
    const { status } = trust(entry);
    const flag = status === 'disputed' ? ' ⚠disputed' : status === 'stale' ? ' ⚠stale' : '';
    return `- \`${entry.id}\` · **${entry.kind}**${flag}${sourceLabel(entry, domain)} — ${entry.title}\n    ${entry.gist}`;
  });
  return `${entries.length} lesson(s) on record for ${domain}; showing ${ranked.length}` +
    `${goal ? `, ranked against "${goal}"` : ''}.\n\n${rows.join('\n')}\n\n` +
    `Open the ones you need: domain_open({ url: "${domain}", ids: [...] }).\n` +
    `Stuck on something instead? domain_unstick({ url, symptom }).`;
}

/**
 * How many lessons arrive already open.
 *
 * The measured arm served eight and won by a wide margin on both scenarios that
 * had real knowledge to serve. It also lost two turns on a page holding a
 * single lesson the agent would never have opened — so a bigger brief is not
 * free, and the tail is named rather than pasted. Eight is what was measured;
 * it is not a tuned value, and there is no evidence here for any other.
 */
const HEAD = 8;

/**
 * The whole brief in one answer: the ranked head already open, the tail named.
 *
 * The tail is deliberately not an invitation. `renderBrief` ends with "Open the
 * ones you need", and that sentence is what a round trip is made of — the ids
 * are listed here so an agent that wants one can ask, and nothing suggests it
 * should.
 */
export function renderInline(
  domain: string, entries: SourcedLesson[], ranked: SourcedLesson[], head: number, goal?: string,
): string {
  const open = ranked.slice(0, head);
  const rest = ranked.slice(head);
  return `${entries.length} lesson(s) on record for ${domain}; ` +
    `the ${open.length} most relevant are below in full` +
    `${goal ? `, ranked against "${goal}"` : ''}.\n\n` +
    `${open.map(entry => renderFull(entry, domain)).join('\n\n')}` +
    (rest.length
      ? `\n\n_Also here, less relevant: ${rest.map(entry => `\`${entry.id}\``).join(', ')}._`
      : '');
}

const emptyBrief = (domain: string): string =>
  `No memory for ${domain} yet — you are the first agent here.\n\n` +
  `When you finish, call domain_remember for anything that would have saved you time. ` +
  `Highest value first:\n` +
  KINDS.map(kind => `- **${kind}** — ${KIND_HELP[kind]}`).join('\n');

/**
 * The memory tools, described as data so the gateway can advertise them
 * alongside the proxied browser tools without a second server.
 */
/**
 * @param inline whether the brief answers in full, which is the shipped
 *   behaviour, or lists titles and asks for a second call.
 *
 *   Threaded rather than read from the environment so this file stays a pure
 *   description of the tools. `BROWSER_MEMORY_WITHOUT=inline` restores the old
 *   staged form, which is the only reason the parameter still exists: the
 *   comparison has to stay runnable.
 *
 *   Measured over 51 runs. Staged disclosure was built to save tokens and cost
 *   `domain_brief` → `domain_open` → `domain_report`, three calls per domain
 *   before any work began, on two scenarios: 17.3 → 11.3 turns and 16.8 → 10.0
 *   once the same content arrived in one call. A turn costs more than tokens,
 *   because every turn re-reads the whole conversation — the rule this project
 *   already applied to the tool list and never to the brief.
 *
 *   The first attempt at measuring this changed only the text appended to a
 *   navigation and left this tool staged. The agent calls it anyway, because
 *   this description tells it to, so the arm still spent `domain_open` twice a
 *   run — the exact cost it was built to remove — and still improved, which is
 *   what makes a half-applied change dangerous.
 */
export function memoryTools(store: MemoryStore, inline = true): LocalTool[] {
  return [
    {
      name: 'domain_brief',
      title: 'What earlier agents learned about this site',
      description: inline
        ? 'Call this BEFORE working on any website, with the URL you are about to visit. Returns, in ' +
          'full, what previous agents learned there — API shortcuts that skip the UI, the exact steps ' +
          'and addresses that already worked, known failures and their fixes. Everything you need is ' +
          'in the answer; nothing has to be opened separately. Passing your goal ranks it against that. ' +
          'Skipping this means rediscovering, slowly, what is already known.'
        : 'Call this BEFORE working on any website, with the URL you are about to visit. Returns a ' +
          'ranked, one-line-per-item summary of what previous agents learned there — API shortcuts that ' +
          'skip the UI, steps that already worked, known failures and their fixes. Deliberately terse to ' +
          'stay cheap; pull the full text of only the items you need with domain_open. Passing your goal ' +
          'ranks the results against it. Skipping this means rediscovering, slowly, what is already known.',
      schema: {
        url: z.string().describe('The URL or domain you are about to work on.'),
        goal: z.string().optional().describe('What you are trying to accomplish; used to rank results.'),
        limit: z.number().optional().describe('How many to return in full. Defaults to 8.'),
      },
      handle: async args => {
        const { url, goal, limit } = args as { url: string; goal?: string; limit?: number };
        const domain = normalizeDomain(url);
        const entries = await store.applicable(domain);
        if (!entries.length)
          return emptyBrief(domain);
        const ranked = rank(entries, goal);
        if (!inline)
          return renderBrief(domain, entries, ranked.slice(0, limit ?? 12), goal);
        return renderInline(domain, entries, ranked, limit ?? HEAD);
      },
    },
    {
      name: 'domain_open',
      title: 'Read specific lessons in full',
      description:
        'Fetch the complete text — including runnable snippets — for lessons you picked out of ' +
        'domain_brief. Open only what you will act on; that is what keeps this cheap. An id ending ' +
        '`-superseded` is what a lesson said before it was corrected: it answers "when did this ' +
        'change, and to what", and it is labelled as something not to act on.',
      schema: {
        url: z.string().describe('The URL or domain.'),
        ids: z.array(z.string()).describe('Lesson ids from domain_brief.'),
      },
      handle: async args => {
        const { url, ids } = args as { url: string; ids: string[] };
        const domain = normalizeDomain(url);
        /*
         * Retired claims are readable here and nowhere else automatic.
         *
         * `applicable` hides them because a brief is pushed at an agent that is
         * about to act, and a claim kept for the record of when it stopped
         * holding is not something to hand it unasked. This is the opposite
         * situation: the agent has named one id and is asking what is under it.
         * Refusing there is what leaves a store able to say only that nothing
         * is known about exports, so the next agent tries the old route and
         * spends the same ten minutes finding out it 404s.
         */
        const entries = await store.applicable(domain, { includeInvalidated: true });
        const found = ids.map(id => entries.find(entry => entry.id === id)).filter(Boolean) as SourcedLesson[];
        const missing = ids.filter(id => !entries.some(entry => entry.id === id));
        if (!found.length)
          return `No lesson matched ${ids.join(', ')} for ${domain}.`;
        const tail = missing.length ? `\n\n_Not found: ${missing.join(', ')}._` : '';
        return `${found.map(entry => renderFull(entry, domain)).join('\n\n---\n\n')}${tail}\n\n---\n\n` +
          `After you act on these, call domain_report so the next agent knows whether they still hold.`;
      },
    },
    {
      name: 'domain_unstick',
      title: 'Someone hit this exact wall before',
      description:
        'Call this the moment something on a site does not behave as expected — an unexpected redirect, ' +
        'an error banner, an element that will not appear, a request that keeps failing. Describe the ' +
        'symptom exactly as you observe it (paste the error text or URL verbatim if you have one) and ' +
        'this returns fixes earlier agents recorded for that symptom. Try this before you start ' +
        'guessing; the fix is usually already written down.',
      schema: {
        url: z.string().describe('The URL or domain where you are stuck.'),
        symptom: z.string().describe('What you observe, verbatim where possible: error text, unexpected URL, missing element.'),
      },
      handle: async args => {
        const { url, symptom } = args as { url: string; symptom: string };
        const domain = normalizeDomain(url);
        const matches = matchSymptom(await store.applicable(domain), symptom);
        if (!matches.length) {
          return `Nothing on record for that symptom on ${domain}.\n\n` +
            `Once you work it out, record it: domain_remember({ url, kind: "fix", trigger: "<the symptom, ` +
            `as the next agent will see it>", title, gist, body }). A fix without a recognizable trigger ` +
            `cannot be found again — put the literal error text or URL in the trigger.`;
        }
        return `${matches.length} known fix(es) matching that symptom on ${domain}:\n\n` +
          `${matches.slice(0, 4).map(entry => renderFull(entry, domain)).join('\n\n---\n\n')}\n\n---\n\n` +
          `If one worked: domain_report({ url, id, outcome: "worked" }). If it did not, report "failed" ` +
          `with a note — two failures and it stops being offered.`;
      },
    },
    {
      name: 'domain_remember',
      title: 'Record what you learned for the next agent',
      description:
        'Write down something that will save the next agent time on this site. Re-using an existing ' +
        'title overwrites that lesson, so correcting yourself is cheap and duplicates do not pile up.\n\n' +
        'Write for a stranger who has none of your context. Be specific and concrete: real selectors, ' +
        'real endpoints, real error strings. "The dashboard is slow" helps nobody; "GET /api/v1/stats ' +
        'returns the same numbers the dashboard renders, no UI needed" saves ten minutes.\n\n' +
        'Pass url:"*" for a lesson that holds on any site — how SPAs are usually built, where to look ' +
        'first on an unfamiliar dashboard. Those are what make the first visit to an unknown site fast.\n\n' +
        'Credentials are stripped automatically before anything is written, so never paste a token to ' +
        '"make the snippet complete" — write the snippet as it should be run, without secrets.\n\n' +
        'Kinds, most valuable first:\n' +
        KINDS.map(kind => `- ${kind} — ${KIND_HELP[kind]}`).join('\n'),
      schema: {
        url: z.string().describe('The URL or domain this applies to. Use the apex domain if it holds across subdomains, or "*" if it holds on any site anywhere.'),
        kind: z.enum(KINDS).describe('Which kind of lesson this is.'),
        title: z.string().describe('Short, specific, and stable — it is the identity of this lesson.'),
        gist: z.string().describe('One line stating the payoff. This is all the next agent sees before deciding to open it.'),
        body: z.string().optional().describe('The full explanation: what to do, what to watch out for, why.'),
        snippet: z.string().optional().describe('Runnable JS (a fetch against the internal API, a Playwright sequence). The single biggest time-saver.'),
        trigger: z.string().optional().describe('For kind=fix: the symptom as the next agent will observe it — literal error text or URL.'),
        tags: z.array(z.string()).optional().describe('Words that help this surface for a related goal.'),
      },
      handle: async args => {
        const { url, ...fields } = args as {
          url: string; kind: Kind; title: string; gist: string;
          body?: string; snippet?: string; trigger?: string; tags?: string[];
        };
        const domain = normalizeDomain(url);
        const { action, entry, redacted } = await store.remember(domain, fields);
        const note = action === 'confirmed'
          ? 'Identical to what was already recorded, so its confidence went up.'
          : action === 'updated'
            ? 'Replaced the previous version and reset its failure count.'
            : 'New lesson.';
        const scope = domain === GLOBAL_SCOPE ? 'every site' : domain;
        const warning = redacted
          ? ` ⚠ ${redacted} credential-shaped value(s) were redacted before saving — check the lesson still reads correctly.`
          : '';
        return `${action} \`${entry.id}\` on ${scope}. ${note}${warning}`;
      },
    },
    {
      name: 'domain_report',
      title: 'Say whether a lesson actually held',
      description:
        'After acting on a lesson from domain_open or domain_unstick, report the outcome. This is what ' +
        'keeps the memory trustworthy: confirmations raise confidence and refresh the verified date, ' +
        'failures lower it, and two failures demote a lesson to disputed so it stops misleading people. ' +
        'One call, and every later agent benefits.',
      schema: {
        url: z.string().describe('The URL or domain.'),
        id: z.string().describe('The lesson id.'),
        outcome: z.enum(['worked', 'failed']).describe('Did following it produce the expected result?'),
        note: z.string().optional().describe('On failure: what actually happened. Recorded on the lesson.'),
      },
      handle: async args => {
        const { url, id, outcome, note } = args as {
          url: string; id: string; outcome: 'worked' | 'failed'; note?: string;
        };
        const domain = normalizeDomain(url);
        // Only where the lesson could actually have come from: this domain, its
        // parents, and the global scope — the same chain a brief is drawn from.
        // Searching every domain instead meant two sites with a same-named
        // lesson would credit or blame the wrong one, and whichever happened to
        // be listed first always won.
        for (const candidate of [...domainChain(domain), GLOBAL_SCOPE]) {
          const entry = await store.report(candidate, id, outcome, note);
          if (entry)
            return `Recorded on ${candidate}/\`${entry.id}\`: ${trustLabel(entry)}`;
        }
        return `No lesson \`${id}\` found for ${domain} or anything it inherits from.`;
      },
    },
    {
      name: 'domain_forget',
      title: 'Delete a lesson that is simply wrong',
      description:
        'Remove a lesson entirely. Prefer domain_report({ outcome: "failed" }) when you are unsure — ' +
        'that preserves the evidence trail. Delete only what is flatly wrong or obsolete.',
      schema: {
        url: z.string().describe('The URL or domain.'),
        id: z.string().describe('The lesson id to delete.'),
      },
      handle: async args => {
        const { url, id } = args as { url: string; id: string };
        const domain = normalizeDomain(url);
        const removed = await store.forget(domain, id);
        return removed ? `Deleted \`${removed.id}\` from ${domain}.` : `No lesson \`${id}\` on ${domain}.`;
      },
    },
    {
      name: 'domain_index',
      title: 'Which sites have memory',
      description: 'List every domain with recorded lessons, how many, and how often they have been used.',
      schema: {},
      handle: async () => {
        const rows = await store.index();
        if (!rows.length)
          return 'No domain memory recorded yet.';
        return `${rows.length} domain(s) with memory:\n\n` +
          rows.map(row =>
            `- **${row.domain}** — ${row.count} lesson(s) [${row.kinds.join(', ')}], used ${row.used}×` +
            `${row.disputed ? `, ${row.disputed} disputed` : ''}, updated ${row.updated}`).join('\n');
      },
    },
  ];
}
