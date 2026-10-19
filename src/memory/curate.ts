import { LOOKS_LIKE_API, normalizePath } from '../capture/apiMap.ts';
import { tokenize, trust } from './store.ts';
import type { Endpoint } from '../capture/apiMap.ts';
import type { Lesson, Procedure } from '../types.ts';
import { daysSince } from '../lib/dates.ts';

/**
 * Curation is a consolidation pass over knowledge that has already accumulated,
 * not a generator of knowledge nobody asked for. It runs on a domain that has
 * earned it through real use.
 *
 * The split matters: everything here is deterministic candidate-finding —
 * overlap, staleness, literals that look like they should have been parameters,
 * lessons that cannot both be true. Deciding whether two lessons are really the
 * same thing, whether a pattern generalizes, or which half of a disagreement is
 * the true one, is a judgement, and this module deliberately does not make it.
 * It hands the agent evidence and lets it decide.
 */

/** Below this a domain has not accumulated enough for consolidation to be worth the tokens. */
export const CURATE_THRESHOLD = 10;
/** How similar two lessons must be before they are worth a look. */
const DUPLICATE_SIMILARITY = 0.45;
/** Cross-domain similarity high enough to suspect a lesson is about the web, not the site. */
const GLOBAL_SIMILARITY = 0.55;
/** A lesson nobody has used, that nobody has confirmed, after this long, is probably noise. */
const UNUSED_AFTER_DAYS = 60;

/**
 * The store's tokenizer, not a second one. The copy that used to live here read
 * `[a-z0-9]{3,}` off lowercased text, so it never split a compound identifier
 * and never saw a short word — `getVpsList` and `get vps list` were unrelated
 * strings to it while the ranker treated them as the same. A near-duplicate
 * written in the other convention was invisible to the pass whose entire job is
 * finding near-duplicates.
 */
const tokens = (text: string): Set<string> => new Set(tokenize(text));

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size)
    return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token))
      shared += 1;
  }
  return shared / (a.size + b.size - shared);
}

const lessonText = (entry: Lesson): string => `${entry.title} ${entry.gist} ${entry.body}`;

export type CurationTarget = {
  domain: string;
  entries: Lesson[];
  procedures: Procedure[];
  /**
   * What the site's own pages were seen calling. Optional because a domain can
   * reach the curation threshold before any traffic was captured, and an empty
   * map is not evidence of absence — with nothing observed, "never observed"
   * would indict every endpoint anyone has ever written down.
   */
  endpoints?: Endpoint[];
};

/**
 * Two lessons that cannot both be true, or one lesson the site's own traffic
 * does not support.
 *
 * Kept apart from duplicates because the cost is different in kind. A duplicate
 * makes the next agent read the same thing twice and then do the right thing. A
 * contradiction makes it do the wrong thing, with the store's authority behind
 * the choice, and reading both halves does not reveal which half is wrong —
 * that is what makes it worth finding mechanically rather than on the way past.
 */
export type Contradiction = {
  kind: 'dead-end-vs-fast-path' | 'opposite-advice' | 'method-mismatch' | 'unobserved';
  /** The route both sides are talking about, normalized the way the API map normalizes. */
  path: string;
  a: Lesson;
  /** The other side, when it is a lesson. `unobserved` is a lesson against the traffic. */
  b?: Lesson;
  /** What the reader needs on top of the two titles to see the conflict. */
  detail: string;
};

export type Findings = {
  contradictions: Contradiction[];
  duplicates: { a: Lesson; b: Lesson; score: number }[];
  disputed: Lesson[];
  stale: Lesson[];
  unused: Lesson[];
  globalCandidates: { entry: Lesson; alsoOn: string; matched: string; score: number }[];
  parameterization: { procedure: Procedure; literals: string[]; suspicious: boolean }[];
  brokenProcedures: Procedure[];
  unverifiedProcedures: Procedure[];
  promotable: Lesson[];
};

/**
 * Values baked into a procedure that look like they belong to one particular
 * run. A procedure that hardcodes the id it happened to be written against is
 * the most common way this whole idea fails, and it is invisible until someone
 * tries to reuse it.
 */
function hardcodedCandidates(procedure: Procedure): { literals: string[]; suspicious: boolean } {
  const declared = new Set(procedure.params.map(param => param.name));
  const code = procedure.code || '';

  const longNumbers = code.match(/\b\d{4,}\b/g) ?? [];
  const uuids = code.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) ?? [];
  // Quoted values sitting in a URL path or query — the shape an id takes.
  const inPaths = [...code.matchAll(/['"`][^'"`]*\/(\d{3,}|[0-9a-f-]{8,})[^'"`]*['"`]/gi)].map(match => match[0]);

  const literals = [...new Set([...longNumbers, ...uuids, ...inPaths])];
  return {
    literals,
    // Zero parameters plus embedded identifiers is the strongest signal of all.
    suspicious: literals.length > 0 && declared.size === 0,
  };
}

/**
 * Ids collapsed exactly the way `apiMap` collapses them, because the entire
 * point is to hold what a lesson claims against what the site was seen doing,
 * and two normalizations that disagree never meet. `${…}` is handled as well:
 * a lesson's snippet is code, and the id in code is usually an interpolation
 * rather than a literal — the same reason `observe` collapses it there.
 *
 * Imported from apiMap rather than reimplemented: the whole check is "does the
 * route this lesson names appear in what we actually saw", and two normalizers
 * that drift apart answer that with a confident no for every endpoint on the
 * site.
 *
 * `LOOKS_LIKE_API` comes from there for the same reason, and is needed because
 * the map never records ordinary pages — without it, a lesson about
 * `/dashboard/websites` would be reported as citing an endpoint that does not
 * exist, along with every other page on the site.
 */

/**
 * A route named anywhere in a lesson — prose, snippet or trigger, with or
 * without a host in front of it.
 *
 * An interpolation counts as one character of path. Closing braces are excluded
 * from the run so a route mentioned inside prose does not swallow the bracket
 * after it — but that also cut `/servers/${id}/metrics` down to
 * `/servers/${id`, and a template literal is exactly the form every
 * automatically captured fast-path arrives in. So the snippets this system
 * writes itself were the ones it could not read back: their routes never
 * matched the traffic, never matched a procedure built from the same endpoint,
 * and the normalizer that exists to reconcile the two never saw a whole path to
 * work on.
 *
 * Two further guards do the rest. The leading one rejects a slash that is part
 * of a word, without which `and/or` in an ordinary sentence parses as the route
 * `/or` and every lesson with a conjunction in it becomes a candidate. And the
 * verb is matched case-sensitively, because "to get /orders working" is a
 * sentence, not a GET request.
 */
const CITATION =
  /(?<![\w/])(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+)?(?:https?:\/\/[^\s'"`)]+?)?(\/[A-Za-z0-9$:](?:\$\{[^}]*\}|[^\s'"`,;)\]}<>])*)/g;

/** A route a lesson cites, with whatever verbs it named alongside it. */
type Citation = { path: string; methods: string[] };

function citations(entry: Lesson): Citation[] {
  const byPath = new Map<string, Citation>();
  // The snippet counts as much as the prose: an automatically captured
  // fast-path puts the endpoint in a `fetch` call and only paraphrases it above.
  const text = `${lessonText(entry)} ${entry.snippet} ${entry.trigger}`;
  for (const [, method, raw] of text.matchAll(CITATION)) {
    // Query strings and fragments are per-call, and prose leaves punctuation
    // stuck to the end of a path far more often than it leaves it off.
    const path = normalizePath((raw ?? '').split(/[?#]/)[0]!.replace(/[.,:;!?/]+$/, ''));
    // One segment is a word with a slash in front of it. Two is a route — or
    // one, if a verb vouched for it.
    if (!path.startsWith('/') || (!method && path.split('/').filter(Boolean).length < 2))
      continue;
    const cited = byPath.get(path) ?? { path, methods: [] };
    if (method && !cited.methods.includes(method))
      cited.methods.push(method);
    byPath.set(path, cited);
  }
  return [...byPath.values()];
}

/**
 * Whether this lesson has already become a tool.
 *
 * Matched on the route both sides name, because that is the thing they are
 * actually about. The previous test asked whether a procedure's description
 * contained the lesson's title verbatim — a description an agent writes in its
 * own words for a human to read, against a title written separately in other
 * words. It essentially never matched, so every fast-path lesson stayed on the
 * promote list forever, including the ones already promoted, and the section
 * became a standing recommendation to do work that was done.
 *
 * Both sides go through the same normalizer as everything else here, so
 * `/servers/${id}/metrics` in a snippet and `/servers/:id/metrics` in generated
 * code are recognised as one endpoint.
 */
function alreadyAProcedure(entry: Lesson, procedures: Procedure[]): boolean {
  const routes = new Set(citations(entry).map(cited => cited.path));
  if (!routes.size)
    return false;
  return procedures.some(procedure => {
    const code = `${procedure.code} ${procedure.description}`;
    for (const [, , raw] of code.matchAll(CITATION)) {
      if (routes.has(normalizePath((raw ?? '').split(/[?#]/)[0]!.replace(/[.,:;!?/]+$/, ''))))
        return true;
    }
    return false;
  });
}

/** Phrases that turn a claim about a route into a warning against it. */
const AGAINST = /\b(?:no longer|never|not|cannot|can not|deprecated|removed|gone|forbidden|blocked|useless|dead[ -]?end|avoid|fails?|failing|broken|refuses?|rejects?|403|404|410)\b|n['’]t\b/i;
/** And the opposite, consulted only once a negation has been ruled out. */
const FOR = /\b(?:works?|working|succeeds?|returns?|gives?|use|call|fastest|faster|instead|200)\b/i;

/**
 * Which way a lesson points about the routes it names.
 *
 * The kind is a verdict the author already gave, so it wins over the words. It
 * has to: a `fix` reads exactly like a warning because it quotes the error it
 * works around, and it means the opposite — this is the route that works once
 * you know the trick. Only the kinds that carry no verdict of their own —
 * `fact`, `auth`, `landmark` — are read from their text, and only from the
 * title and gist, which is where a lesson states its claim. Bodies are where
 * the caveats live and they negate freely.
 */
function advice(entry: Lesson): 'for' | 'against' | 'unclear' {
  if (entry.kind === 'dead-end')
    return 'against';
  if (entry.kind === 'fast-path' || entry.kind === 'recipe' || entry.kind === 'fix')
    return 'for';
  const claim = `${entry.title} ${entry.gist}`;
  if (AGAINST.test(claim))
    return 'against';
  return FOR.test(claim) ? 'for' : 'unclear';
}

function findContradictions(entries: Lesson[], endpoints: Endpoint[]): Contradiction[] {
  // A superseded lesson is kept as the record of a claim that stopped being
  // true, so disagreeing with whatever replaced it is the job it was left here
  // to do — not a finding.
  const cited = entries
      .filter(entry => !entry.invalidated)
      .map(entry => ({ entry, paths: citations(entry), says: advice(entry) }))
      .filter(item => item.paths.length);

  const found: Contradiction[] = [];
  for (let i = 0; i < cited.length; i++) {
    for (let j = i + 1; j < cited.length; j++) {
      const left = cited[i]!;
      const right = cited[j]!;
      for (const here of left.paths) {
        const there = right.paths.find(candidate => candidate.path === here.path);
        if (!there)
          continue;
        const opposed = left.says !== right.says && left.says !== 'unclear' && right.says !== 'unclear';
        const differentVerbs = here.methods.length > 0 && there.methods.length > 0 &&
          !here.methods.some(method => there.methods.includes(method));

        // Different verbs plus opposite advice is not a disagreement at all:
        // "POST there is rejected" and "GET there returns the list" are both
        // true at once. Reporting it would spend the reader's attention on the
        // one category that is supposed to be worth it.
        if (differentVerbs) {
          if (!opposed) {
            found.push({
              kind: 'method-mismatch', path: here.path, a: left.entry, b: right.entry,
              detail: `\`${here.methods.join('/')}\` in one, \`${there.methods.join('/')}\` in the other, ` +
                `both offered as the way to reach it — at most one of them is what the site accepts.`,
            });
          }
          continue;
        }
        if (!opposed)
          continue;

        const warns = left.says === 'against' ? left : right;
        const recommends = warns === left ? right : left;
        found.push(warns.entry.kind === 'dead-end' && recommends.entry.kind === 'fast-path'
          ? {
            kind: 'dead-end-vs-fast-path', path: here.path, a: warns.entry, b: recommends.entry,
            detail: 'written off as a dead end, and recommended as a fast path.',
          }
          : {
            kind: 'opposite-advice', path: here.path, a: warns.entry, b: recommends.entry,
            detail: 'one says it does not work, the other says it does.',
          });
      }
    }
  }

  if (endpoints.length) {
    // Matched on the path alone: seeing the site issue any request to a route
    // proves the route exists, whatever verb a lesson happens to name.
    const observed = new Set(endpoints.map(endpoint => endpoint.path));
    for (const { entry, paths, says } of cited) {
      // A dead end naming a route the site never calls is corroborated by the
      // map, not contradicted by it.
      if (says === 'against')
        continue;
      /*
       * Absence from the map is weak evidence, and this is where that has to be
       * respected rather than asserted past.
       *
       * The map holds traffic from pages somebody opened. An endpoint missing
       * from it may simply live on a page nobody has visited — which is exactly
       * what happened on the first real corpus: hPanel's metrics endpoint was
       * flagged against a lesson that had been confirmed by use and describes a
       * 422 the agent saw with its own eyes. A lesson that has worked is not
       * made suspect by silence.
       *
       * So it only speaks about claims nothing has ever backed, and it is not
       * filed as a contradiction: there is no second claim to weigh it against.
       */
      if (entry.confirmed > 0)
        continue;
      for (const { path } of paths) {
        if (!LOOKS_LIKE_API.test(path) || observed.has(path))
          continue;
        found.push({
          kind: 'unobserved', path, a: entry,
          detail: `${endpoints.length} endpoint(s) were captured from this site's own traffic and this ` +
            `is not one of them. That is not proof it is wrong — the map only covers pages someone ` +
            `opened — but nothing has confirmed this lesson either.`,
        });
      }
    }
  }
  return found;
}

export function analyze(target: CurationTarget, others: { domain: string; entries: Lesson[] }[]): Findings {
  const { procedures } = target;
  /*
   * Every finder below reads the live store, not the record beside it.
   *
   * A retired copy is the previous wording of the entry that replaced it, so on
   * similarity it scores near 1.0 against its own replacement — it would be
   * reported as a duplicate to merge on every pass, forever, and merging it is
   * the one thing that would destroy what it is kept for. It is stale by
   * construction and unused by construction, so it would land in dead weight
   * too. `findContradictions` filters them itself, and for its own reason:
   * disagreeing with what replaced it is the job it was left here to do.
   */
  const entries = target.entries.filter(entry => !entry.invalidated);
  const indexed = entries.map(entry => ({ entry, tokens: tokens(lessonText(entry)) }));

  const duplicates: Findings['duplicates'] = [];
  for (let i = 0; i < indexed.length; i++) {
    for (let j = i + 1; j < indexed.length; j++) {
      const score = jaccard(indexed[i]!.tokens, indexed[j]!.tokens);
      if (score >= DUPLICATE_SIMILARITY)
        duplicates.push({ a: indexed[i]!.entry, b: indexed[j]!.entry, score: Number(score.toFixed(2)) });
    }
  }
  duplicates.sort((x, y) => y.score - x.score);

  const globalCandidates: Findings['globalCandidates'] = [];
  for (const { entry, tokens: entryTokens } of indexed) {
    for (const other of others) {
      const match = other.entries.find(candidate => jaccard(entryTokens, tokens(lessonText(candidate))) >= GLOBAL_SIMILARITY);
      if (match) {
        globalCandidates.push({
          entry,
          alsoOn: other.domain,
          matched: match.title,
          score: Number(jaccard(entryTokens, tokens(lessonText(match))).toFixed(2)),
        });
        break;
      }
    }
  }

  return {
    contradictions: findContradictions(entries, target.endpoints ?? []),
    duplicates,
    disputed: entries.filter(entry => trust(entry).status === 'disputed'),
    stale: entries.filter(entry => trust(entry).status === 'stale'),
    unused: entries.filter(entry =>
      entry.used === 0 && entry.confirmed <= 1 && daysSince(entry.created) >= UNUSED_AFTER_DAYS),
    globalCandidates,
    parameterization: procedures
        .map(procedure => ({ procedure, ...hardcodedCandidates(procedure) }))
        .filter(finding => finding.literals.length),
    brokenProcedures: procedures.filter(procedure => procedure.status === 'broken'),
    unverifiedProcedures: procedures.filter(procedure => procedure.status === 'unverified'),
    promotable: entries.filter(entry =>
      entry.kind === 'fast-path' && entry.snippet && !alreadyAProcedure(entry, procedures)),
  };
}
