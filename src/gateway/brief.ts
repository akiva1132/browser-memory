/**
 * What the agent is told on arrival, assembled from every store at once.
 *
 * This is the premise of the whole gateway in one place. Recall that depends on
 * an agent remembering to ask for it is recall that mostly does not happen —
 * measured at zero across a 49-turn session — so what is known about a site is
 * appended to the navigation that goes there, whether or not anybody asked.
 *
 * It is also where the campaign's shipped finding lives: the brief arrives
 * finished. Staged disclosure cost `domain_brief` → `domain_open` →
 * `domain_report` before any work began, and removing that round trip took 17.3
 * turns to 11.3 on one scenario and 16.8 to 10.2 on another while serving more
 * content. A sentence that asks for a second call is what a second call is made
 * of.
 */
import {
  normalizeDomain,
} from '../memory/store.ts';
import { rank, symptomFrom, volunteeredFix } from '../memory/recall.ts';
import { renderBrief, renderFull, renderInline } from '../memory/tools.ts';
import { CURATE_THRESHOLD } from '../memory/curateTools.ts';
import { renderApiMap } from '../capture/apiMap.ts';
import { renderPlaces } from '../browser/places.ts';
import { apiMap, briefed, places, store, trace } from './context.ts';
import { without } from './ablation.ts';

/**
 * Where the agent's tab actually is, taken from the tab listing that every
 * browser tool appends to its result.
 *
 * Trusting the `url` argument of `browser_navigate` instead means the answer
 * goes stale the moment a link is clicked, a form is submitted, or a
 * single-page app changes route — after which observations are filed against
 * the previous site and a brief for the new one never appears at all.
 */
export const CURRENT_TAB = /^-\s*\d+:\s*\(current\)\s*\[(.*?)\]\((.*)\)\s*$/m;

export function currentPageFrom(body: string): { domain: string; path: string; title: string } {
  const match = CURRENT_TAB.exec(body);
  if (!match)
    return { domain: '', path: '', title: '' };
  try {
    // The path identifies which form a flow belongs to; the query string is
    // usually one errand's arguments and would make every visit a new page.
    // The title was already being matched here and discarded — it is the only
    // human-readable name a route ever gets, and the place map needs it.
    return { domain: normalizeDomain(match[2]!), path: new URL(match[2]!).pathname, title: match[1] ?? '' };
  } catch {
    // about:blank and friends: real, but nothing to attribute knowledge to.
    return { domain: '', path: '', title: '' };
  }
}

/**
 * When the agent lands somewhere new, append what is known about it. This is
 * the whole reason the gateway exists: recall that depends on the agent
 * remembering to ask for it is recall that mostly does not happen.
 */
export async function memoryNudge(domain: string): Promise<string | undefined> {
  if (!domain || briefed.has(domain))
    return undefined;
  briefed.add(domain);
  const entries = without('lessons') ? [] : await store.applicable(domain).catch(() => []);
  // Learned from watching the site's own traffic, so it is often the only thing
  // present on a domain no agent has deliberately written anything about.
  const observed = without('api') ? [] : await apiMap.forDomain(domain).catch(() => []);
  const api = observed.length ? `\n\n${renderApiMap(domain, observed)}` : '';
  /*
   * Said before the lessons rather than after, when there is something to say.
   *
   * The knowledge here has a shelf life set by somebody else's release
   * schedule, and the store has no way to notice a redesign on its own. The
   * traffic does: routes that used to answer and now return an error were
   * recorded as breaking, at no cost, while mining ran anyway. An agent about
   * to act on a store written against the old version of a site should be told
   * that first, because everything below it is now suspect.
   */
  const changed = without('api')
    ? { broken: [] as typeof observed, quiet: [] }
    : await apiMap.drift(domain).catch(() => ({ broken: [], quiet: [] }));
  const drifted = changed.broken.length
    ? `\n\n⚠ **${changed.broken.length} endpoint(s) here stopped answering** ` +
      `(${changed.broken.slice(0, 3).map(endpoint => `\`${endpoint.path}\` → ${endpoint.status}`).join(', ')}` +
      `${changed.broken.length > 3 ? ', …' : ''}). The site has changed since some of this was written — ` +
      `treat anything below that names those routes as out of date, and report what you find.`
    : '';
  // Both halves of a repeat visit: what can be read here, and how to get there.
  const known = without('places') ? [] : await places.established(domain).catch(() => []);
  const map = known.length ? `\n\n${renderPlaces(domain, known)}` : '';
  // Asking for a write-up is deliberately not done here. This text arrives as
  // the agent is starting, which is the wrong moment to ask anyone what they
  // learned, and an unconditional request read as boilerplate: a 49-turn
  // session recorded nothing and reported that it had. That request now lives
  // in the Stop hook, fires at the end, and only when calls actually failed.
  /*
   * What this domain is actually worth, itemised.
   *
   * This is the product's central claim in one number per layer, and until now
   * it was invisible: a warm run that beat a cold one beat it by *something*,
   * and which of the four contributed was not recorded anywhere. Written before
   * the early return so a domain that produces nothing says so too — silence
   * and "nothing known" looked identical from the outside.
   */
  const served = {
    lessons: entries.length, endpoints: observed.length,
    places: known.length, broken: changed.broken.length,
  };
  const inventory = `${served.lessons} lesson(s), ${served.endpoints} endpoint(s), ` +
    `${served.places} place(s)`;
  if (!entries.length) {
    const anything = Boolean(api || map);
    trace.write('serve', domain, anything
      ? `Briefing ${domain} with no written lessons, but ${inventory} from watching the site.`
      : `Nothing known about ${domain} — the agent starts cold here.`, served);
    return anything
      ? `\n\n---\n\n**No agent has written anything about ${domain}, but the site has been watched.**${drifted}${map}${api}`
      : undefined;
  }
  trace.write('serve', domain, `Briefing ${domain}: ${inventory}` +
    `${served.broken ? `, and warning that ${served.broken} endpoint(s) stopped answering` : ''}.`,
    served);
  const ranked = rank(entries).slice(0, 8);
  const own = entries.filter(entry => !entry.global).length;
  const curated = await store.curatedAt(domain).catch(() => null);
  // Only suggested once a domain has actually accumulated something. Curation
  // is consolidation of real use, not a chore to run on an empty store.
  const nudge = own >= CURATE_THRESHOLD && !curated
    ? `\n\n_${own} lessons have piled up here and have never been consolidated. ` +
      `When you are done, \`domain_curate\` will point out duplicates, hardcoded values and dead weight._`
    : '';
  /*
   * Already open, because opening it cost more than sending it.
   *
   * `renderBrief` lists titles and ends with "Open the ones you need", and that
   * sentence is what a round trip is made of: `domain_open` to read it and
   * `domain_report` to close the loop, three calls per domain before any work
   * happens. `renderFull` carries the body, the trigger and the snippet —
   * exactly what `domain_open` would have returned — so the answer is complete
   * on arrival and nothing asks for a second call.
   *
   * The curation nudge goes with it. It is another sentence asking for a call,
   * and it fires precisely on the domains that already have the most to read.
   */
  const lessons = without('inline')
    ? renderBrief(domain, entries, ranked)
    : renderInline(domain, entries, rank(entries), ranked.length);
  /*
   * Written to answer the objection agents actually raised, rather than to
   * describe the tool.
   *
   * Three of four runs that caught a false lesson left it in place, and all
   * three gave a version of "this is shared state you did not ask me to
   * modify". That is not reluctance to use a tool they had; it is a judgement
   * about scope, and it is a correct one until someone says otherwise. So this
   * says otherwise, and says it about the case that came up: a lesson that
   * turns out to be wrong, and a replacement that could not be verified.
   *
   * Only on domains that have something to be wrong about.
   */
  const correction = entries.length && !without('correction')
    ? `\n\n_If any of this turns out to be wrong, correcting it is part of the job rather than a ` +
      `change you were not asked to make: \`domain_report({ url: "${domain}", id, outcome: "failed" })\` ` +
      `marks it for the next agent, and \`domain_remember\` with the same title replaces it. Say so ` +
      `even when you cannot verify the replacement — an unchallenged wrong lesson is obeyed by ` +
      `everyone after you._`
    : '';
  return `\n\n---\n\n**Earlier agents have worked on ${domain}.** ` +
    `Read this before proceeding — it may already contain what you are about to work out.\n\n` +
    `${drifted}${lessons}${map}${api}${correction}${without('inline') ? nudge : ''}`;
}

/**
 * The same recall as `domain_unstick`, fired by the failure instead of by the
 * agent noticing it should ask.
 *
 * `matchSymptom` was written, tested and reachable only from a tool call, which
 * makes it recall that mostly does not happen — the identical shape as capture
 * depending on the agent choosing to write things down, which was measured
 * failing at exactly 0 lessons across a 49-turn session. The gateway already
 * sees every error body. It just was not looking at them.
 *
 * A page's own text is attacker-controlled, so nothing here is executed or
 * trusted: the error string is only ever used to look up something a previous
 * run wrote down, and what comes back is the stored lesson, not the page.
 */
export async function unstickHint(domain: string, body: string): Promise<string | undefined> {
  const symptom = symptomFrom(body);
  if (!symptom)
    return undefined;
  const best = volunteeredFix(await store.applicable(domain).catch(() => []), symptom);
  if (!best)
    return undefined;
  return `\n\n---\n\n**This exact symptom is on record for ${domain}.**\n\n` +
    `${renderFull(best, domain)}\n\n` +
    `_Report the outcome: \`domain_report({ url: "${domain}", id: "${best.id}", outcome: "worked" | "failed" })\`. ` +
    `Two failures and it stops being offered._`;
}

