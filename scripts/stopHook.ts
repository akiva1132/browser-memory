#!/usr/bin/env node
/**
 * Asks for what was learned at the moment the work is finished, instead of at
 * the moment it starts.
 *
 * Until now that request rode along with the brief injected after the first
 * navigation — the worst possible time to ask someone to summarize, and
 * measurably ineffective: a 49-turn session across three sites recorded
 * nothing and reported that it had.
 *
 * `Stop` fires when the turn actually ends, which is the right moment. But
 * timing alone is not the fix. An unconditional reminder at the end is still a
 * reminder, and the reason the last one failed is that it was unconditional —
 * it appeared whether or not anything had happened, so it read as boilerplate.
 *
 * So this speaks only with evidence, taken from the gateway's own audit log
 * rather than from the agent's account of itself: a site where calls actually
 * failed this turn, and where nothing was written down afterwards. When there
 * is no such site it prints nothing at all, which is most turns.
 *
 * It can never block, fail a turn, or take one down: every path exits 0.
 *
 * Install (in ~/.claude/settings.json):
 *   "hooks": { "Stop": [{ "hooks": [{ "type": "command",
 *     "command": "node '<repo>/scripts/stopHook.ts'" }] }] }
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { defaultMemoryDir } from '../src/lib/roots.ts';

const memoryDir = defaultMemoryDir;
const auditFile = path.join(memoryDir, 'audit.jsonl');
/** Byte offset into the audit log, so each turn reads only its own calls. */
const cursorFile = path.join(memoryDir, '.stop-cursor');

/** One failure is a typo. Repeated failure on one site is something worth knowing. */
const FRICTION = 2;

type AuditEvent = {
  tool?: string;
  args?: { url?: string };
  outcome?: string;
};

/** Only the hostname; the audit log holds full URLs and those carry ids. */
function hostOf(url: unknown): string {
  if (typeof url !== 'string')
    return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

async function readSinceCursor(): Promise<AuditEvent[]> {
  const size = await fs.stat(auditFile).then(stat => stat.size).catch(() => -1);
  if (size < 0)
    return [];
  const previous = await fs.readFile(cursorFile, 'utf8').then(Number).catch(() => 0);
  // A log that shrank was rotated or cleared. Replaying it from the start would
  // report friction from days ago as though it had just happened.
  const from = Number.isFinite(previous) && previous <= size ? previous : size;
  await fs.writeFile(cursorFile, String(size), 'utf8').catch(() => {});
  if (from >= size)
    return [];

  const handle = await fs.open(auditFile, 'r').catch(() => undefined);
  if (!handle)
    return [];
  try {
    const buffer = Buffer.alloc(size - from);
    await handle.read(buffer, 0, buffer.length, from);
    return buffer.toString('utf8').split('\n')
        .filter(Boolean)
        .flatMap(line => {
          try {
            return [JSON.parse(line) as AuditEvent];
          } catch {
            return [];
          }
        });
  } finally {
    await handle.close();
  }
}

function report(events: AuditEvent[]): string {
  const failures = new Map<string, number>();
  const recorded = new Set<string>();
  // Attribution follows navigation: a failing evaluate or click carries no URL
  // of its own, so it belongs to whatever page was last opened.
  let where = '';

  for (const event of events) {
    const host = hostOf(event.args?.url);
    if (event.tool === 'browser_navigate' && host)
      where = host;
    if (event.tool === 'domain_remember' || event.tool === 'procedure_save')
      recorded.add(host || where);
    if (event.outcome === 'error' && event.tool?.startsWith('browser_') && where)
      failures.set(where, (failures.get(where) ?? 0) + 1);
  }

  const stuck = [...failures.entries()]
      .filter(([host, count]) => count >= FRICTION && !recorded.has(host))
      .sort((a, b) => b[1] - a[1]);
  if (!stuck.length)
    return '';

  const worst = stuck.slice(0, 3)
      .map(([host, count]) => `**${host}** (${count} failed calls)`)
      .join(', ');
  return `Before this turn closes: ${worst} — nothing was recorded about ${stuck.length > 1 ? 'those sites' : 'that site'}.\n\n` +
    `If you worked out *why* those calls failed, one \`domain_remember\` call saves the next agent the ` +
    `same detour: the argument that was wrong, the endpoint that answered what the UI was showing, the ` +
    `route that looked right and was not. If they were only typos or a page still loading, this is noise ` +
    `— skip it and say nothing.`;
}

try {
  const context = report(await readSinceCursor());
  if (context) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: context },
    }));
  }
} catch {
  // A hook that throws is a hook that breaks every session on the machine.
  // There is nothing here worth that.
}
process.exit(0);
