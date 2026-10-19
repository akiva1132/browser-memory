/**
 * The report that turns four numbers into a diagnosis.
 *
 * Everything here is arithmetic over two log files, which is exactly the kind of
 * code that goes wrong quietly: the answer still looks like a report, and the
 * number in it is simply not true. Both defects pinned below were found by
 * reading real output rather than by suspecting them, and both had already been
 * written into a paragraph of conclusions before anyone checked.
 */
import assert from 'node:assert/strict';

import type { AuditEvent } from '../../src/lib/audit.ts';
import { oneSession, phasesOf, renderDossier } from '../../src/report/dossier.ts';
import type { TraceEvent } from '../../src/lib/trace.ts';

const at = (ms: number): string => new Date(Date.parse('2026-08-06T10:00:00.000Z') + ms).toISOString();
const call = (
  ms: number, tool: string, over: Partial<AuditEvent> = {},
): AuditEvent => ({ at: at(ms), session: 'run-2', tool, outcome: 'ok', ms: 100, ...over });

// ── one run's events, out of a log that several gateways share ────────────────
//
// The log copied out at the end of a warm run holds days of other sessions,
// because every gateway on the machine appends to the live store's audit log.
// Reconstructing the run's window from the file name and the duration left a
// minute of slack at the front; the previous session's last call landed inside
// it, and the gap between the two was charged to the model as thinking. A
// 53-second run reported 92 seconds of thought — a number that reads as a
// finding about where time goes, which is the whole question this file answers.
{
  const events: AuditEvent[] = [
    call(0, 'browser_navigate', { session: 'run-1' }),
    call(1_000, 'browser_click', { session: 'run-1' }),
    call(61_000, 'browser_navigate'),
    call(64_000, 'browser_click'),
  ];
  const mine = oneSession(events);
  assert.deepEqual(mine.map(event => event.session), ['run-2', 'run-2'],
      'only the session that ran last belongs to the run whose log this is');

  const before = phasesOf(events);
  const after = phasesOf(mine);
  assert.ok((before.get('(before the first navigation)')?.thinkMs ?? 0) >= 59_000,
      'the unfiltered version charges the whole gap between sessions to thinking');
  assert.equal([...after.values()].reduce((sum, phase) => sum + phase.thinkMs, 0), 2_900,
      'the filtered one counts only the gaps inside the run');
  console.log('  a shared log is narrowed to the one session that ran, not to a time window');
}

// ── the gap belongs to the page that was open while the model thought ─────────
{
  const phases = phasesOf([
    call(0, 'browser_navigate', { args: { url: 'https://first.example/a' } }),
    call(5_000, 'browser_click'),
    call(9_000, 'browser_navigate', { args: { url: 'https://second.example/b' } }),
    call(30_000, 'browser_snapshot'),
  ]);
  assert.equal(phases.get('first.example')?.calls, 2, 'the click belongs to the page it was made on');
  assert.equal(phases.get('second.example')?.thinkMs, 20_900,
      'and the twenty seconds after arriving belong to where the agent arrived');
  assert.ok(!phases.has('(before the first navigation)'),
      'a run that opens with a navigation has no time before it');
  console.log('  time is attributed to the page that was open, not to the call that follows it');
}

// ── an uncomputable section and an empty one must not read alike ──────────────
//
// Fifty-four of the runs on disk predate the trace log. A dossier that renders
// "nothing was learned" for those is not reporting a result, it is reporting
// the absence of an instrument, and the difference is the difference between
// "this feature does nothing" and "nobody measured".
{
  const facts = { scenario: 'x', mode: 'warm', seconds: 10, turns: 3, costUsd: 0.5 };
  const old = renderDossier(facts, [call(0, 'browser_navigate')], []);
  assert.match(old, /predates the trace log/, 'no trace at all says so');
  assert.doesNotMatch(old, /Nothing was written/, 'and must not claim the run learned nothing');

  const quiet: TraceEvent[] = [
    { at: at(0), session: 'run-2', kind: 'call', what: 'browser_navigate', detail: 'went somewhere' },
  ];
  const empty = renderDossier(facts, [call(0, 'browser_navigate')], quiet);
  assert.match(empty, /Nothing was written/, 'a trace that recorded no learning says that instead');
  assert.doesNotMatch(empty, /predates the trace log/);
  console.log('  a section that could not be computed is distinguished from one that came back empty');
}

// ── a broken instrument does not render like a result ─────────────────────────
//
// Three runs of `600s · 0 turns · $0.00` once went into a median because they
// printed in the same shape as runs that worked.
{
  const broken = renderDossier(
      { scenario: 'x', mode: 'warm', seconds: 600, turns: 0, costUsd: 0, broken: 'stalled', error: 'no calls' },
      [], []);
  assert.match(broken, /NOT A MEASUREMENT — STALLED/);
  assert.doesNotMatch(broken.split('\n')[2] ?? '', /600s · 0 turns/,
      'the headline must not offer numbers that are not measurements');
  assert.match(broken, /never started/, 'and a run with no calls at all is named as such');
  console.log('  a broken run is marked as not a measurement rather than reported as one');
}

// ── failures carry their reason ───────────────────────────────────────────────
{
  const text = renderDossier(
      { scenario: 'x', mode: 'warm', seconds: 10, turns: 2, costUsd: 0.1 },
      [call(0, 'browser_click', { outcome: 'error', note: 'element is not visible' })], []);
  assert.match(text, /element is not visible/,
      'an error row with no reason is barely better than no row');
  console.log('  a failed call is reported with what the site actually said');
}

console.log('DOSSIER OK');
