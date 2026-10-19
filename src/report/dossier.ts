import fs from 'node:fs/promises';

import type { AuditEvent } from '../lib/audit.ts';
import type { TraceEvent } from '../lib/trace.ts';

/**
 * What a measured run actually did, rather than what it cost.
 *
 * A result file used to hold four things: seconds, turns, dollars, and the
 * agent's closing message. Twenty runs of that is sixty numbers and no
 * diagnosis — a warm arm that beats a cold one beats it by *something*, and
 * which of the four memory layers contributed was recorded nowhere. Runs are
 * the scarce resource here: each one is a real session, serialised behind the
 * browser lock, against a usage limit that is reached in an afternoon. Spending
 * them at four facts each is the waste worth fixing before buying more.
 *
 * Everything below is already on disk when a run ends. The audit log holds
 * every call with its outcome and duration; the trace holds the gateway's own
 * decisions. Nothing here measures anything new — it joins two files nobody was
 * joining.
 *
 * Runs recorded before the trace existed still produce a dossier, with the
 * sections that need one saying so. An empty section and a section that could
 * not be computed must not look the same.
 */

/**
 * One log's worth of events, from a moment onwards.
 *
 * Both logs are shared: every gateway using a memory directory appends to them,
 * and a chained experiment reuses one directory across runs on purpose. Reading
 * a whole file would open run two's dossier with run one's calls and credit
 * them to the wrong arm. A missing file is empty rather than fatal — runs older
 * than the trace have no trace, and that is a section that says so, not a crash.
 */
export async function eventsSince<T extends { at: string }>(
  file: string, since?: string,
): Promise<T[]> {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).flatMap(line => {
    try {
      const event = JSON.parse(line) as T;
      return since && event.at < since ? [] : [event];
    } catch {
      return [];
    }
  });
}

/**
 * The events of one gateway, picked out of a log several of them share.
 *
 * A run is one Claude session, which is one gateway, which is one session id —
 * so the id is an exact answer where a time window is only a guess. It has to
 * be exact: reconstructing the window from a file name and a duration left a
 * minute of slack at the front, the previous session's last call landed inside
 * it, and the gap between the two was attributed to the model thinking. A
 * 53-second run reported 92 seconds of thought.
 *
 * The run in question is the last one in the file, since the log was copied out
 * when it ended.
 */
export function oneSession<T extends { at: string; session?: string }>(events: T[]): T[] {
  const latest = events.reduce<T | undefined>(
      (best, event) => !best || event.at > best.at ? event : best, undefined);
  return latest?.session ? events.filter(event => event.session === latest.session) : events;
}

export type RunFacts = {
  scenario: string;
  mode: string;
  prompt?: string;
  output?: string;
  seconds?: number;
  turns?: number;
  costUsd?: number;
  checks?: { name: string; passed: boolean }[];
  /** Set when the instrument broke rather than the run failing. Never a measurement. */
  broken?: string;
  error?: string;
};

type Phase = { calls: number; navigations: number; errors: number; callMs: number; thinkMs: number };

const hostOf = (url: unknown): string => {
  if (typeof url !== 'string')
    return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

/**
 * Where the wall clock went, attributed to whatever page was open at the time.
 *
 * The gap between one call ending and the next beginning is the model thinking,
 * and it is usually most of a run. Separating it from time spent waiting on the
 * browser is what tells you whether a slow task was hunting around a site —
 * which site knowledge fixes — or composing an answer, which it does not.
 */
export function phasesOf(events: AuditEvent[]): Map<string, Phase> {
  const phases = new Map<string, Phase>();
  const phaseOf = (name: string): Phase => {
    const existing = phases.get(name) ?? { calls: 0, navigations: 0, errors: 0, callMs: 0, thinkMs: 0 };
    phases.set(name, existing);
    return existing;
  };
  let where = '(before the first navigation)';
  let previousEnd = 0;
  for (const event of events) {
    const end = Date.parse(event.at);
    const start = end - (event.ms ?? 0);
    if (previousEnd && start > previousEnd)
      phaseOf(where).thinkMs += start - previousEnd;
    const host = hostOf((event.args as { url?: unknown } | undefined)?.url);
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
  return phases;
}

const table = (header: string[], rows: string[][]): string =>
  [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`,
    ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n');

/** Long arguments are named, not quoted: a dossier is read, not replayed. */
function argSummary(event: AuditEvent): string {
  const args = event.args as Record<string, unknown> | undefined;
  if (!args || typeof args !== 'object')
    return '';
  const url = typeof args['url'] === 'string' ? args['url'] : undefined;
  if (url)
    return url.length > 60 ? `${url.slice(0, 60)}…` : url;
  const element = typeof args['element'] === 'string' ? args['element'] : undefined;
  if (element)
    return element;
  const keys = Object.keys(args);
  return keys.length ? `${keys.length} arg(s): ${keys.slice(0, 4).join(', ')}` : '';
}

export function renderDossier(
  facts: RunFacts, audit: AuditEvent[], trace: TraceEvent[],
): string {
  const calls = audit.filter(event => event.tool && !event.tool.startsWith('_'))
      .sort((a, b) => a.at.localeCompare(b.at));
  const started = calls.length ? Date.parse(calls[0]!.at) - (calls[0]!.ms ?? 0) : 0;
  const out: string[] = [];

  out.push(`# ${facts.scenario} (${facts.mode})`);
  out.push('');
  if (facts.broken) {
    // Deliberately not shaped like a result. Three broken runs once went into a
    // median because they printed like ordinary ones.
    out.push(`> **NOT A MEASUREMENT — ${facts.broken.toUpperCase()}.** ${facts.error ?? ''}`);
    out.push('>');
    out.push('> Nothing below is a measurement of memory. Fix the instrument and run it again.');
  } else {
    out.push(`${facts.seconds ?? '?'}s · ${facts.turns ?? '?'} turns · ` +
      `$${(facts.costUsd ?? 0).toFixed(2)} · ${calls.length} browser call(s)`);
  }
  out.push('');

  if (facts.checks?.length) {
    out.push('## Checks');
    out.push(facts.checks.map(check => `- ${check.passed ? 'PASS' : 'FAIL'} ${check.name}`).join('\n'));
    out.push('');
  }

  // ── what memory was worth here ──────────────────────────────────────────────
  out.push('## What memory was served');
  const served = trace.filter(event => event.kind === 'serve');
  if (!trace.length) {
    out.push('_Not recorded: this run predates the trace log, which is where the gateway ' +
      'writes what it served. Only what can be recovered from the audit log appears below._');
  } else if (!served.length) {
    out.push('_Nothing. No domain in this run had anything on record._');
  } else {
    out.push(table(['domain', 'lessons', 'endpoints', 'places', 'flows', 'note'],
        served.map(event => {
          const data = event.data ?? {};
          return [event.what, String(data['lessons'] ?? 0), String(data['endpoints'] ?? 0),
            String(data['places'] ?? 0), String(data['flows'] ?? 0),
            data['broken'] ? `⚠ ${String(data['broken'])} endpoint(s) had stopped answering` : ''];
        })));
  }
  out.push('');

  // ── what it left behind ─────────────────────────────────────────────────────
  out.push('## What the run learned');
  const learned = trace.filter(event =>
    event.kind === 'observe' && ['learn', 'flow', 'cap'].includes(event.what));
  if (!trace.length)
    out.push('_Not recorded: this run predates the trace log._');
  else if (!learned.length)
    out.push('_Nothing was written. No flow completed and no claim reached its threshold._');
  else
    out.push(learned.map(event => `- ${event.detail}`).join('\n'));
  out.push('');

  // ── everything that did not go to plan ──────────────────────────────────────
  //
  // The agent's closing message is not a source for this. A run that hit six
  // timeouts and recovered reports success, truthfully, and the six are the
  // part worth reading.
  out.push('## Everything that did not go to plan');
  const wrong = calls.filter(event => event.outcome !== 'ok');
  const spoiled = trace.filter(event => event.kind === 'observe' && event.what === 'spoil');
  const gates = trace.filter(event => event.kind === 'gate');
  if (!wrong.length && !spoiled.length && !gates.length) {
    out.push('_Nothing. Every call succeeded and nothing was refused._');
  } else {
    if (wrong.length) {
      out.push(table(['at', 'tool', 'outcome', 'what happened'],
          wrong.map(event => [
            started ? `+${seconds(Date.parse(event.at) - started)}` : event.at.slice(11, 19),
            `\`${event.tool}\``, event.outcome,
            (event.note ?? '').replace(/\|/g, '\\|').slice(0, 160) || '—',
          ])));
      out.push('');
    }
    for (const event of [...spoiled, ...gates])
      out.push(`- ${event.detail}`);
  }
  out.push('');

  // ── where the time went ─────────────────────────────────────────────────────
  out.push('## Where the time went');
  const phases = phasesOf(calls);
  if (!phases.size) {
    out.push('_No calls were recorded._');
  } else {
    out.push(table(['on', 'calls', 'navigations', 'errors', 'waiting on the browser', 'thinking'],
        [...phases].map(([where, phase]) => [where, String(phase.calls), String(phase.navigations),
          String(phase.errors), seconds(phase.callMs), seconds(phase.thinkMs)])));
    const think = [...phases.values()].reduce((sum, phase) => sum + phase.thinkMs, 0);
    const call = [...phases.values()].reduce((sum, phase) => sum + phase.callMs, 0);
    out.push('');
    out.push(`Waiting on the browser ${seconds(call)}, thinking ${seconds(think)}. ` +
      `Site knowledge can only shorten the first column and the hunting inside the second.`);
  }
  out.push('');

  // ── the calls themselves ────────────────────────────────────────────────────
  out.push('## Every call, in order');
  if (!calls.length) {
    out.push('_None. The run made no tool call at all, which is the shape of an agent that never started._');
  } else {
    out.push('<details><summary>' + `${calls.length} calls` + '</summary>');
    out.push('');
    out.push(table(['+', 'tool', 'ms', '', 'arguments'],
        calls.map(event => [
          started ? seconds(Date.parse(event.at) - started) : '',
          `\`${event.tool}\``, String(event.ms ?? ''),
          event.outcome === 'ok' ? '' : `**${event.outcome}**`,
          argSummary(event).replace(/\|/g, '\\|'),
        ])));
    out.push('');
    out.push('</details>');
  }
  out.push('');

  if (facts.prompt) {
    out.push('## Prompt');
    out.push(facts.prompt);
    out.push('');
  }
  if (facts.output) {
    out.push('## What the agent reported');
    out.push(facts.output);
    out.push('');
  }
  if (facts.error && !facts.broken) {
    out.push('## Harness error');
    out.push(facts.error);
    out.push('');
  }
  return out.join('\n');
}
