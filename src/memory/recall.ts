/**
 * Which lessons to put in front of an agent, and which to volunteer unasked.
 *
 * The store's job is to hold knowledge and keep its trust record honest. This
 * is the other half — deciding what is relevant right now — and it shares
 * nothing with reading and writing files. It is also the half with the taste in
 * it: what counts as a symptom, how much a verbatim trigger outweighs word
 * overlap, when a fix is confident enough to offer without being asked.
 */
import { KINDS, tokenize, trust } from './store.ts';
import type { SourcedLesson } from './store.ts';

/**
 * Lexical relevance, deliberately not embeddings: it is deterministic, needs no
 * model call, and the vocabulary of a single site is small enough that word
 * overlap works. Kind and trust break ties so a proven fast-path outranks a
 * loosely-matching fact.
 */
export function rank<T extends SourcedLesson>(entries: T[], goal?: string): T[] {
  const wanted = new Set(tokenize(goal));
  const scored = entries.map(entry => {
    // Counted once per distinct word. Counting every occurrence let a lesson
    // inflate its own relevance by repeating a goal word across its title, gist
    // and tags — which the shorter and more repetitive an entry is, the easier
    // it becomes, so the entries saying least scored highest.
    const haystack = new Set(tokenize(`${entry.title} ${entry.gist} ${entry.tags.join(' ')}`));
    let overlap = 0;
    for (const word of haystack) {
      if (wanted.has(word))
        overlap += 1;
    }
    const { score, status } = trust(entry);
    const kindBonus = (KINDS.length - KINDS.indexOf(entry.kind)) * 0.5;
    let penalty = status === 'stale' ? 1.5 : 0;
    // Knowledge about this site beats knowledge about sites in general.
    if (entry.global)
      penalty += 2;
    return {
      entry,
      // 0 trusted, 1 disputed, 2 invalidated. Trust tiers sort; they do not
      // subtract.
      tier: entry.invalidated ? 2 : status === 'disputed' ? 1 : 0,
      score: (wanted.size ? overlap * 3 : 0) + kindBonus + Math.min(score, 5) - penalty,
    };
  });
  /*
   * Any penalty large enough today is still just a number, and a lesson the
   * store itself flags as unreliable will match some goal word for word while a
   * healthy one matches loosely — precisely the case where it must not lead.
   * Disputed used to be a subtraction of 6 against an overlap worth 3 apiece,
   * so three shared words was enough to put a twice-failed lesson at the top of
   * the brief. Sorting by tier makes "below every trusted lesson" true whatever
   * the arithmetic above it says.
   *
   * Sorted rather than filtered: a disputed lesson is a hypothesis, not a lie,
   * and on a site where it is the only thing anyone knows it is still the best
   * available answer — carrying its warning with it.
   */
  return scored
      .sort((a, b) => a.tier - b.tier || b.score - a.score)
      .map(item => item.entry);
}

/**
 * The bar for offering a fix nobody asked for.
 *
 * Only a trigger found verbatim in the error text clears it. When an agent
 * calls `domain_unstick` it has already decided it is stuck and will read
 * whatever comes back, so loose word overlap earns its place there. Attaching a
 * fix to an error unbidden is different: it arrives while the agent is mid-task
 * and reading something irrelevant costs attention on every failed call, of
 * which a bad session has many.
 */
export const VERBATIM_TRIGGER = 10;

/**
 * How much text has to be shared before "quoted verbatim" means anything.
 *
 * Containment is tested both ways, because the useful match runs in both
 * directions: an error string is usually longer than the trigger written for
 * it, and a trigger copied from a longer message is sometimes the longer of the
 * two. What that symmetry cost was a floor. `trigger.includes('')` is true, so
 * `domain_unstick` called with an empty symptom scored *every* lesson carrying
 * a trigger at the maximum and reported them all as known fixes for it — and a
 * three-letter symptom did the same against any trigger containing those three
 * letters.
 *
 * So whichever side is the contained one has to be substantial on its own. A
 * trigger is written to be recognised — literal error text, a URL — and none of
 * those are shorter than this.
 */
const MIN_VERBATIM_CHARS = 12;

const SYMPTOM_CHARS = 600;

/**
 * The site's complaint, separated from our own additions to the response.
 *
 * Every browser tool result carries a trailing `### Open tabs` block, and the
 * gateway may already have appended a brief below a `---` rule. Matching
 * against those means matching a domain's memory against itself, which scores
 * well and means nothing.
 */
export function symptomFrom(body: string): string {
  return body.split('### Open tabs')[0]!.split('\n\n---\n\n')[0]!.trim().slice(0, SYMPTOM_CHARS);
}

/**
 * The one fix worth interrupting an agent with, or nothing.
 *
 * Two rules separate this from `domain_unstick`, and both come from the same
 * place: nobody asked. The trigger has to appear verbatim in the error, and a
 * fix that has failed its last two attempts is not offered at all — the same
 * treatment a broken procedure gets, withheld from the path where it would be
 * pushed at someone and still reachable by an agent that goes looking.
 */
export function volunteeredFix<T extends SourcedLesson>(
  entries: T[], symptom: string,
): T | undefined {
  const trusted = entries.filter(entry => trust(entry).status !== 'disputed');
  return matchSymptom(trusted, symptom, VERBATIM_TRIGGER)[0];
}

/** Whether `inner` appears in `outer` and is long enough for that to be evidence. */
const quotes = (outer: string, inner: string): boolean =>
  inner.length >= MIN_VERBATIM_CHARS && outer.includes(inner);

/** Symptom matching for the unstick path: a fix is only useful if its trigger is recognizable. */
export function matchSymptom<T extends SourcedLesson>(
  entries: T[], symptom: string, minScore = 3,
): T[] {
  const words = new Set(tokenize(symptom));
  const lower = symptom.toLowerCase();
  return entries.map(entry => {
    const trigger = (entry.trigger || '').toLowerCase();
    let score = 0;
    // A trigger quoted verbatim in the symptom (an error string, a URL) is the
    // strongest possible signal — that is exactly what triggers are written for.
    // The contained side carries the evidence, so it is the side measured.
    if (quotes(lower, trigger) || quotes(trigger, lower))
      score += VERBATIM_TRIGGER;
    for (const word of tokenize(`${entry.trigger} ${entry.title} ${entry.gist}`)) {
      if (words.has(word))
        score += 1;
    }
    if (entry.kind === 'fix')
      score += 2;
    score -= trust(entry).status === 'disputed' ? 5 : 0;
    return { entry, score };
  }).filter(item => item.score >= minScore).sort((a, b) => b.score - a.score).map(item => item.entry);
}
