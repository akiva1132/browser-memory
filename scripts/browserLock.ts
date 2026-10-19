#!/usr/bin/env node
/**
 * One job at a time against the real browser.
 *
 * There is exactly one Chrome here, holding the user's live sessions, reached
 * through one upstream MCP server. Every consumer — a measured run, an
 * integration suite, a one-off probe — attaches to that same instance and
 * claims a tab from it. Nothing prevented two of them running at once, and the
 * cost of finding that out was three wedged measurements in one hour: a probe
 * run beside a measurement, then `npm test` run beside another, which starts
 * four gateways at once in the concurrency suite.
 *
 * The reason it kept happening is worth stating plainly, because it decided
 * the shape of this file. Each time, the response was a detector — something
 * that notices the damage sooner. A detector cannot prevent anything; it only
 * shortens the report. Exclusion is a lock, held by the operating system,
 * enforced on every consumer whether or not anyone remembered the rule.
 *
 *   node scripts/browserLock.ts <command> [args…]
 *
 * Runs the command holding the lock and releases it however the command ends,
 * including on SIGINT and SIGTERM. If the lock is held, it says who has it and
 * exits 1 immediately rather than queueing — a job that waits ten minutes for a
 * lock is indistinguishable from the hang this exists to prevent.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK = path.join(os.tmpdir(), 'browser-memory-browser.lock');

type Holder = { pid: number; what: string; since: string };

const readHolder = (): Holder | undefined => {
  try {
    return JSON.parse(fs.readFileSync(LOCK, 'utf8')) as Holder;
  } catch {
    return undefined;
  }
};

/** A lock whose owner is gone is not a lock. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const argv = process.argv.slice(2);
if (!argv.length) {
  console.error('usage: node scripts/browserLock.ts <command> [args…]');
  process.exit(2);
}

const what = argv.join(' ');
const holder = readHolder();
if (holder && holder.pid !== process.pid && alive(holder.pid)) {
  console.error(
      `✖ the browser is in use by pid ${holder.pid} since ${holder.since}:\n` +
      `    ${holder.what}\n` +
      `  Wait for it, or stop it. Running both is what wedges the stack.`);
  process.exit(1);
}

// Stale locks are cleared rather than honoured: the alternative is a crashed
// job blocking every later one until someone deletes a file by hand.
if (holder && !alive(holder.pid))
  console.error(`(clearing a stale lock from pid ${holder.pid} — ${holder.what})`);

fs.writeFileSync(LOCK, JSON.stringify({
  pid: process.pid, what, since: new Date().toISOString(),
} satisfies Holder), 'utf8');

let released = false;
const release = (): void => {
  if (released)
    return;
  released = true;
  // Only if it is still ours: a stale-lock takeover by another process must not
  // be undone by our own exit.
  const current = readHolder();
  if (current?.pid === process.pid)
    fs.rmSync(LOCK, { force: true });
};

process.on('exit', release);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    release();
    process.exit(130);
  });
}

const child = spawn(argv[0]!, argv.slice(1), { stdio: 'inherit' });
child.on('close', (code, signal) => {
  release();
  process.exit(signal ? 130 : code ?? 0);
});
