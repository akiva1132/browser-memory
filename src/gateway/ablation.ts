/**
 * Everything one arm of a measurement can go without, and what each one takes
 * away.
 *
 * These exist so each addition is measured against its own absence rather than
 * argued about. Off is the shipped behaviour — `BROWSER_MEMORY_WITHOUT=api` in
 * one arm, unset in the other — so a plain install never depends on an
 * environment variable being present. Several can be named at once, comma
 * separated.
 *
 * The switch used to know two names, and neither of them was a memory layer —
 * so a warm run that beat a cold one beat it by *something*, and no combination
 * of runs could say which. These four are the product's actual claims, and each
 * has to be removable on its own or none of them is measured.
 *
 * A cut has to be complete to be worth making. Removing a layer from the brief
 * while leaving the tool that serves it is not an arm without that layer, it is
 * an arm where the agent pays an extra turn to get it anyway — which would show
 * up as the feature being *worth* something. So each name withdraws the tools
 * as well.
 */
export const ABLATABLE: Record<string, { what: string; tools: string[] }> = {
  lessons: { what: 'written lessons', tools: ['domain_brief', 'domain_open', 'domain_unstick', 'domain_index', 'domain_curate'] },
  api: { what: 'the observed API map', tools: ['domain_interface', 'procedure_draft'] },
  places: { what: 'the map of pages agents reached', tools: [] },
  /*
   * The old staged brief, kept runnable because it is what the default now
   * replaces and the comparison has to stay repeatable.
   *
   * This began as the arm that separated *delivery* from *knowledge*, and it
   * settled the campaign. Every other switch here removes content, and the two
   * that won the first wave also withdrew tools — five and two, with the effect
   * ordered exactly by how many — so those arms could not support "lessons cost
   * more than they save": two levers in one arm, the charge that sank the LEAN
   * profile. This one removes neither knowledge nor tools, and it beat all of
   * them on both scenarios while serving more: 17.3 → 11.3 turns and
   * 16.8 → 10.0, with `domain_open` and `domain_report` falling to zero.
   *
   * Staged disclosure existed to save tokens. A turn costs more than tokens,
   * because every turn re-reads the whole conversation — the rule this project
   * already applied to the tool list and never to the brief.
   */
  inline: { what: 'the brief arriving in full — back to titles and domain_open', tools: [] },
  /*
   * One sentence telling an agent it is allowed to correct what it was given.
   *
   * Measured before it was written. A lesson marked `confirmed: 3`, false in a
   * way that silently costs half the answer, was planted on a real site and run
   * four times: **four of four refused it**, unprompted, by checking the claim
   * against the data instead of applying it — and named the exact damage it
   * would have done. So this is not a safety fix. Agents do not obey their
   * notes; they check them.
   *
   * **One of four wrote the correction back.** The other three declined for the
   * same reason, in almost the same words: the store is shared state they were
   * not asked to touch, and one refused specifically because it could not
   * verify a replacement first. Every one of those is careful reasoning about a
   * permission nobody had granted — so the missing piece is the grant, and the
   * sentence below is aimed at that sentence rather than at the behaviour.
   *
   * Switchable because the last sentence added to a brief cost six turns a run.
   * That one asked for a call on every domain; this one asks for a call only
   * when something is wrong, which is the difference the arm has to prove
   * rather than assume.
   */
  correction: { what: 'the invitation to correct a lesson that turns out to be false', tools: [] },
  diagnosis: { what: 'the explanation attached to a failed call', tools: [] },
  collapse: { what: 'collapsing a repeated snapshot', tools: [] },
};
export const WITHOUT = new Set((process.env['BROWSER_MEMORY_WITHOUT'] ?? '')
    .split(',').map(name => name.trim()).filter(Boolean));
export const without = (feature: keyof typeof ABLATABLE): boolean => WITHOUT.has(feature);
export const withheldTools = new Set([...WITHOUT].flatMap(name => ABLATABLE[name]?.tools ?? []));
/*
 * A misspelt name is refused rather than ignored.
 *
 * The failure it prevents is the expensive one: an arm that was meant to run
 * without lessons runs with all of them, agrees closely with the control, and
 * the conclusion drawn is that lessons are worth nothing. Nothing about a
 * silently-ignored switch looks wrong at any point.
 */
const unknown = [...WITHOUT].filter(name => !(name in ABLATABLE));
if (unknown.length) {
  console.error(`BROWSER_MEMORY_WITHOUT: no such feature: ${unknown.join(', ')}. ` +
    `Known: ${Object.keys(ABLATABLE).join(', ')}.`);
  process.exit(2);
}
