/**
 * Curation and the discovered interface, as the agent reads them.
 *
 * Kept apart from the analysis for the reason the analysis file already gives
 * for itself: it finds candidates mechanically and refuses to decide which are
 * real. Presentation is where that refusal is either honoured or quietly
 * undone — a heading that says "duplicates" about two lessons that merely share
 * vocabulary has made the judgement the finder declined to make. It is worth
 * being able to read the wording without the 400 lines that produced it.
 */
import { renderProof } from '../capture/apiMap.ts';
import type { Endpoint } from '../capture/apiMap.ts';
import type { Lesson, Procedure, SourcedLesson } from '../types.ts';
import type { Contradiction, CurationTarget, Findings } from './curate.ts';

const bullet = (entry: Lesson): string => `  - \`${entry.id}\` (${entry.kind}) — ${entry.title}`;

/**
 * Carried on every side of a conflict because it is the only mechanical
 * evidence there is for which half to keep. Deciding is the reader's job, and
 * a claim confirmed four times last week against one confirmed once in March
 * is most of the decision.
 */
const record = (entry: Lesson): string =>
  `${entry.confirmed}✓/${entry.failed}✗, verified ${entry.verified}`;

const side = (entry: Lesson): string =>
  `      \`${entry.id}\` (${entry.kind}, ${record(entry)}) "${entry.title}"`;

const conflict = (item: Contradiction): string =>
  `  - \`${item.path}\` — ${item.detail}\n${side(item.a)}` +
  (item.b ? `\n${side(item.b)}` : '');

/**
 * In the order a reader should work through them: the sharpest conflict first.
 *
 * `unobserved` is deliberately not here. It is not a conflict — there is no
 * second claim to weigh against the first, only silence — and grouping it with
 * the others said "these cannot both be true" about a lesson with nothing to
 * disagree with. It gets its own, weaker section.
 */
const CONFLICT_GROUPS: [Contradiction['kind'], string][] = [
  ['dead-end-vs-fast-path', 'Dead end vs fast path'],
  ['opposite-advice', 'Opposite advice about the same route'],
  ['method-mismatch', 'Same route, different verb'],
];

export function renderCuration(domain: string, target: CurationTarget, findings: Findings): string {
  const { procedures } = target;
  // Counted live, like every finder below: a retired copy is not a lesson on
  // the pile, it is the record of one that was corrected.
  const entries = target.entries.filter(entry => !entry.invalidated);
  const retired = target.entries.length - entries.length;
  const sections: string[] = [
    `# Curation pass for ${domain}\n\n` +
    `${entries.length} lesson(s), ${procedures.length} procedure(s)` +
    `${retired ? `, and ${retired} superseded claim(s) kept as a record` : ''}. Everything below is a ` +
    `**candidate**, found mechanically. Nothing has been changed — you decide what is real.`,
  ];

  /*
   * Gated on the conflicts themselves, not on every contradiction found.
   *
   * `unobserved` is in the same list and is deliberately not a conflict — it is
   * one lesson against silence, and it has its own weaker section below. The
   * gate used to be the whole list while the heading and the body counted only
   * the three conflict kinds, so a domain whose only finding was an unobserved
   * claim printed `## Contradictions (0) — read these first` followed by a
   * paragraph telling the reader to decide which of two claims is true, and
   * then nothing at all.
   */
  const conflicts = findings.contradictions.filter(item => item.kind !== 'unobserved');

  // First, because it is the only category here where leaving the store alone
  // is worse than the tokens the entries cost. Everything else on this page is
  // waste; this is misdirection.
  if (conflicts.length) {
    sections.push(
      `## Contradictions (${conflicts.length}) — read these first\n\n` +
      `These are **not** duplicates and must not be merged. A duplicate says one thing twice and ` +
      `still leaves the next agent in the right place; a pair below cannot both be true, so one of ` +
      `them is actively steering work down a route that does not go anywhere — and nothing about ` +
      `reading them says which one. Establish which claim the site actually supports, then re-save ` +
      `the losing entry under its own title with \`domain_remember\`, saying what is true instead. ` +
      `That retires what it said and keeps it — the date it stopped holding and the wording it held ` +
      `until then are the navigation knowledge \`domain_forget\` would take down with the mistake.\n\n` +
      CONFLICT_GROUPS
          .map(([kind, label]) => [label, conflicts.filter(item => item.kind === kind)] as const)
          .filter(([, list]) => list.length)
          .map(([label, list]) => `**${label}** (${list.length})\n${list.map(conflict).join('\n')}`)
          .join('\n\n'));
  }

  const unbacked = findings.contradictions.filter(item => item.kind === 'unobserved');
  if (unbacked.length) {
    sections.push(
      `## Claimed but never seen, and never confirmed (${unbacked.length})\n\n` +
      // Only when there is a section above to be weaker than.
      `${conflicts.length ? 'Weaker than the section above, and phrased that way on purpose. ' : ''}` +
      `This is one lesson against silence rather than against a second claim. The API map holds traffic ` +
      `from pages somebody actually opened, so a missing endpoint may only mean nobody has opened ` +
      `the page that calls it. What makes these worth a look is the combination: no traffic backs ` +
      `them and no agent has ever reported them working. Run one and report the outcome — that ` +
      `settles it either way, and costs a single call.\n` +
      unbacked.map(conflict).join('\n'));
  }

  if (findings.promotable.length) {
    sections.push(
      `## Worth promoting to procedures (${findings.promotable.length})\n\n` +
      `These are fast-paths with runnable snippets that no procedure covers yet. A lesson has to be ` +
      `read and applied; a procedure is simply called. Run the snippet, confirm it works, parameterize ` +
      `whatever varies, then \`procedure_save\`.\n` +
      findings.promotable.map(bullet).join('\n'));
  }

  if (findings.parameterization.length) {
    sections.push(
      `## Procedures with values that look hardcoded (${findings.parameterization.length})\n\n` +
      `A procedure that bakes in the id it was written against cannot be reused, and nothing surfaces ` +
      `that until someone tries. Check each literal: if it would differ on the next call, make it a ` +
      `parameter and re-save under the same name.\n` +
      findings.parameterization.map(finding =>
        `  - \`${finding.procedure.name}\`${finding.suspicious ? ' **(no parameters declared at all)**' : ''} — ` +
        `${finding.literals.slice(0, 6).map(literal => `\`${literal}\``).join(', ')}`).join('\n'));
  }

  if (findings.duplicates.length) {
    sections.push(
      `## Lessons that overlap (${findings.duplicates.length})\n\n` +
      `Similar text, which usually means the same thing learned twice. Merge into whichever title is ` +
      `clearer with \`domain_remember\`, then \`domain_forget\` the other. Keep both only if they really ` +
      `say different things. A pair that also appears under contradictions is not this problem — two ` +
      `lessons about one route that disagree are worded alike, and merging them buries the conflict ` +
      `instead of settling it.\n` +
      findings.duplicates.slice(0, 12).map(pair =>
        `  - ${pair.score} similar — \`${pair.a.id}\` ↔ \`${pair.b.id}\`\n` +
        `      "${pair.a.title}" / "${pair.b.title}"`).join('\n'));
  }

  if (findings.globalCandidates.length) {
    sections.push(
      `## Possibly not about this site at all (${findings.globalCandidates.length})\n\n` +
      `Near-identical lessons exist on other domains, which suggests the knowledge is about how the web ` +
      `works rather than about ${domain}. Re-save the general form with \`url: "*"\` so it reaches the ` +
      `first visit to every unknown site, and drop the per-site copies.\n` +
      findings.globalCandidates.map(candidate =>
        `  - \`${candidate.entry.id}\` — also on ${candidate.alsoOn} as "${candidate.matched}" (${candidate.score})`).join('\n'));
  }

  const deadweight: [string, Lesson[]][] = ([
    ['Disputed — failed more than they held', findings.disputed],
    ['Stale — unverified long enough that the site may have moved on', findings.stale],
    ['Never used, never confirmed', findings.unused],
  ] as [string, Lesson[]][]).filter(([, list]) => list.length);

  if (deadweight.length) {
    sections.push(
      `## Dead weight\n\n` +
      `Every entry costs ranking quality and tokens on every brief. Re-verify what still matters and ` +
      `\`domain_forget\` what does not.\n` +
      deadweight.map(([label, list]) =>
        `**${label}** (${list.length})\n${list.map(bullet).join('\n')}`).join('\n\n'));
  }

  if (findings.brokenProcedures.length || findings.unverifiedProcedures.length) {
    sections.push(
      `## Procedures needing attention\n` +
      (findings.brokenProcedures.length
        ? `\n**Broken — withdrawn from the tool list** (${findings.brokenProcedures.length})\n` +
          findings.brokenProcedures.map(procedure =>
            `  - \`${procedure.name}\` — failed ${procedure.consecutiveFailures} in a row. Fix and re-save, or delete.`).join('\n')
        : '') +
      (findings.unverifiedProcedures.length
        ? `\n\n**Never successfully run** (${findings.unverifiedProcedures.length})\n` +
          findings.unverifiedProcedures.map(procedure =>
            `  - \`${procedure.name}\` — call it once to prove it, or delete it.`).join('\n')
        : ''));
  }

  if (sections.length === 1)
    sections.push(`Nothing to consolidate. The knowledge on ${domain} is clean.`);

  return sections.join('\n\n');
}

/** The site's discovered capability surface — the artifact curation is aiming at. */
export function renderInterface(
  domain: string, entries: SourcedLesson[], procedures: Procedure[], endpoints: Endpoint[] = [],
): string {
  const verified = procedures.filter(procedure => procedure.status === 'verified');
  const other = procedures.filter(procedure => procedure.status !== 'verified');
  const fastPaths = entries.filter(entry => entry.kind === 'fast-path' && entry.snippet);
  const auth = entries.filter(entry => entry.kind === 'auth');
  const deadEnds = entries.filter(entry => entry.kind === 'dead-end');

  if (!procedures.length && !fastPaths.length && !endpoints.length)
    return `${domain} has no callable operations yet — only prose. Run \`domain_brief\` instead.`;

  const signature = (procedure: Procedure): string => {
    const params = procedure.params
        .map(param => `${param.name}${param.required ? '' : '?'}: ${param.type}`)
        .join(', ');
    return `${procedure.name}(${params})`;
  };

  const blocks = [
    `# ${domain} — discovered interface\n\n` +
    `Operations that exist because an agent needed them and proved they work.`,
  ];

  if (verified.length) {
    blocks.push(`## Callable now\n\n` + verified.map(procedure =>
      `### \`${signature(procedure)}\`${procedure.mutating ? ' ⚠ changes state' : ''}\n` +
      `${procedure.description}\n` +
      `${procedure.expects ? `Returns: ${procedure.expects}\n` : ''}` +
      `_${procedure.ok}/${procedure.runs} runs succeeded, last ${procedure.lastRun}. Runs on ${procedure.origin}._`).join('\n\n'));
  }

  if (other.length) {
    blocks.push(`## Not callable\n\n` + other.map(procedure =>
      `- \`${procedure.name}\` — ${procedure.status}` +
      `${procedure.status === 'broken' ? `, failed ${procedure.consecutiveFailures} in a row` : ''}`).join('\n'));
  }

  if (fastPaths.length) {
    blocks.push(`## Known shortcuts not yet turned into operations\n\n` +
      fastPaths.map(entry => `- \`${entry.id}\` — ${entry.title}: ${entry.gist}`).join('\n'));
  }

  // Nobody wrote these down: they are what the site's own pages were seen
  // calling. Listed in full here, unlike in a brief, because this is the
  // reference an agent opens when it is about to do real work.
  if (endpoints.length) {
    blocks.push(`## Endpoints observed on this site\n\n` +
      `Captured from real page traffic — or, where one is marked proven, from an agent that called it ` +
      `directly and got data back. Ordered by how often the site uses each one. ` +
      `Reachable with \`fetch\` from a page on ${domain}, using the session already in the browser.\n\n` +
      endpoints.map(endpoint =>
        `- \`${endpoint.method} ${endpoint.path}\`` +
        `${endpoint.params.length ? ` — ${endpoint.params.join(', ')}` : ''}` +
        ` _(seen ${endpoint.seen}×)_` +
        // The one distinction worth carrying into the reference an agent opens
        // before real work: the site calling a route says it exists, an agent
        // calling it and getting what it wanted says it works.
        `${endpoint.proven ? ` — ✓ proven: returns ${endpoint.proven.returns}` : ''}` +
        // And the call itself, from the same renderer the brief uses. This
        // block said "listed in full here, unlike in a brief" while printing
        // the label of the proof and dropping the proof.
        renderProof(endpoint)).join('\n'));
  }

  if (auth.length)
    blocks.push(`## Access\n\n` + auth.map(entry => `- ${entry.title}: ${entry.gist}`).join('\n'));

  if (deadEnds.length)
    blocks.push(`## Do not bother\n\n` + deadEnds.map(entry => `- ${entry.title}: ${entry.gist}`).join('\n'));

  return blocks.join('\n\n');
}
