#!/usr/bin/env node
/**
 * Where a run's time actually went.
 *
 * The question this exists to settle is whether a long task was slow because
 * the agent was hunting around a site, or because it was thinking — writing a
 * digest is real work and no amount of site knowledge makes it shorter. Those
 * two have completely different answers, and guessing between them is how you
 * spend a week building the wrong thing.
 *
 * Both are recoverable from the audit log without any extra instrumentation.
 * Every entry carries the moment it finished and how long the call took, so the
 * call is `[at - ms, at]` and the gap before the next one is the model thinking.
 * Attributing each gap to the page that was open when it happened turns the log
 * into a per-phase breakdown.
 *
 *   node scripts/timeline.ts <audit.jsonl> [--session <id>]
 */
import fs from 'node:fs/promises';

type Event = { at: string; session: string; tool: string; ms?: number; outcome?: string; args?: { url?: string } };
type Phase = { calls: number; navigations: number; errors: number; callMs: number; thinkMs: number };

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/timeline.ts <audit.jsonl> [--session <id>]');
  process.exit(1);
}
const wanted = rest.includes('--session') ? rest[rest.indexOf('--session') + 1] : undefined;

const events = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as Event];
      } catch {
        return [];
      }
    })
    .filter(event => event.tool && !event.tool.startsWith('_'));

const bySession = new Map<string, Event[]>();
for (const event of events) {
  if (wanted && event.session !== wanted)
    continue;
  const list = bySession.get(event.session) ?? [];
  list.push(event);
  bySession.set(event.session, list);
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;
const pct = (part: number, whole: number): string => `${Math.round((part / whole) * 100)}%`;

const hostOf = (url: unknown): string => {
  if (typeof url !== 'string')
    return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

// Sessions with a couple of calls are the eval harness checking its own work,
// not a run worth breaking down.
const sessions = [...bySession.entries()].filter(([, list]) => list.length >= 10);

for (const [session, list] of sessions) {
  list.sort((a, b) => a.at.localeCompare(b.at));
  const phases = new Map<string, Phase>();
  const phaseOf = (name: string): Phase => {
    const existing = phases.get(name) ?? { calls: 0, navigations: 0, errors: 0, callMs: 0, thinkMs: 0 };
    phases.set(name, existing);
    return existing;
  };

  let where = '(before the first navigation)';
  let previousEnd = 0;
  let firstStart = 0;

  for (const event of list) {
    const end = Date.parse(event.at);
    const start = end - (event.ms ?? 0);
    if (!firstStart)
      firstStart = start;
    // The gap belongs to whatever the agent was looking at while it thought.
    if (previousEnd && start > previousEnd)
      phaseOf(where).thinkMs += start - previousEnd;

    const host = hostOf(event.args?.url);
    if (event.tool === 'browser_navigate' && host)
      where = host;

    const phase = phaseOf(where);
    phase.calls += 1;
    phase.callMs += event.ms ?? 0;
    if (event.tool === 'browser_navigate')
      phase.navigations += 1;
    if (event.outcome === 'error')
      phase.errors += 1;
    previousEnd = end;
  }

  const wall = previousEnd - firstStart;
  const totalCall = [...phases.values()].reduce((sum, phase) => sum + phase.callMs, 0);
  const totalThink = [...phases.values()].reduce((sum, phase) => sum + phase.thinkMs, 0);

  console.log(`\nsession ${session} — ${seconds(wall)} across ${list.length} calls`);
  console.log(`  in the browser ${seconds(totalCall)} (${pct(totalCall, wall)}) · ` +
    `thinking ${seconds(totalThink)} (${pct(totalThink, wall)})`);
  console.log(`\n  where                        calls  nav  err   in browser   thinking`);
  for (const [name, phase] of [...phases.entries()].sort(
      (a, b) => (b[1].callMs + b[1].thinkMs) - (a[1].callMs + a[1].thinkMs))) {
    console.log(
      `  ${name.slice(0, 27).padEnd(28)}${String(phase.calls).padStart(4)}` +
      `${String(phase.navigations).padStart(5)}${String(phase.errors).padStart(5)}` +
      `${seconds(phase.callMs).padStart(12)}${seconds(phase.thinkMs).padStart(11)}`);
  }
}

if (!sessions.length)
  console.log('No session in this log made enough calls to break down.');
else if (sessions.length > 1)
  console.log(`\n${sessions.length} sessions above, oldest first.`);
