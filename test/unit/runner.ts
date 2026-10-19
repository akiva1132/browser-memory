/**
 * The measuring instrument's own failure handling.
 *
 * This exists because of a specific, expensive mistake. Three measured runs in
 * a row came back `600s · 0 turns · $0.00`, which in the report reads exactly
 * like a run that worked and failed its checks. It was nothing of the sort: the
 * upstream browser had accumulated dead sessions, every run after that hung,
 * and half an hour of wall clock went into a measurement that had stopped
 * measuring anything in its first minute. Worse, the numbers were on their way
 * into a median.
 *
 * No browser is involved here. The subject is the runner, so the subject is
 * substituted: a process that hangs, a process that exits well, a process that
 * keeps working. What matters is that the three are told apart.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { runProcess } from '../../eval/runner.ts';
import { cleanup, tempMemoryDir } from '../harness.ts';

const dir = await tempMemoryDir('runner');
const auditFile = path.join(dir, 'audit.jsonl');

const spec = (script: string, over: Record<string, unknown> = {}) => ({
  command: 'node',
  args: ['-e', script],
  cwd: dir,
  env: process.env,
  timeoutMs: 30_000,
  auditFile,
  stallMs: 700,
  heartbeatMs: 100,
  ...over,
});

// ── a process that makes no tool call is stopped, and named ──────────────────
{
  const started = Date.now();
  // Alive and quiet: the exact shape of a wedged browser stack. Without the
  // heartbeat this would run to the timeout and be reported as a result.
  const metrics = await runProcess(spec('setTimeout(() => {}, 30000)'));
  const elapsed = Date.now() - started;

  assert.equal(metrics.broken, 'stalled', 'silence must be recognised as the instrument breaking');
  assert.ok(elapsed < 5000, `it must be caught in about a second, not at the timeout (took ${elapsed}ms)`);
  // It used to say "the browser stack is wedged — restart playwright-mcp",
  // which it then said through four runs while the doctor reported the stack
  // healthy and a real browser call round-tripping. Silence has two causes and
  // this instrument cannot see which, so it now points at the check that can
  // tell them apart instead of naming a culprit.
  assert.match(metrics.error ?? '', /doctor/,
      'the message has to say what to do, or the next person rediscovers this');
  console.log(`  a silent process is called stalled after ${Math.round(elapsed / 100) / 10}s, not at the ceiling`);
}

// ── a process that is working is left alone ──────────────────────────────────
{
  // Writes an audit line every 200ms for a second, then reports like Claude
  // would. Under the same 700ms stall budget as above: what separates it from
  // the previous case is only that it is doing something.
  const working = `
    const fs = require('node:fs');
    let n = 0;
    const timer = setInterval(() => {
      fs.appendFileSync(${JSON.stringify(auditFile)}, JSON.stringify({ n: n++ }) + '\\n');
      if (n > 5) {
        clearInterval(timer);
        process.stdout.write(JSON.stringify({ num_turns: 7, total_cost_usd: 1.25, result: 'done' }));
      }
    }, 200);
  `;
  const metrics = await runProcess(spec(working));
  assert.equal(metrics.broken, undefined, 'a process making tool calls must not be killed');
  assert.equal(metrics.turns, 7);
  assert.equal(metrics.costUsd, 1.25);
  assert.equal(metrics.output, 'done');
  console.log('  a process that keeps making calls is left to finish');
}

// ── a genuine failure is not disguised as a broken instrument ────────────────
{
  await fs.appendFile(auditFile, '{"keeping":"the heartbeat alive"}\n', 'utf8');
  const metrics = await runProcess(spec('process.stdout.write("not json at all")'));
  assert.equal(metrics.broken, undefined,
      'a session that ran and returned nonsense is a result, not a wedged stack');
  assert.equal(metrics.ok, false);
  assert.match(metrics.error ?? '', /could not parse/);
  console.log('  an unparseable result is a failed run, not a broken instrument');
}

// ── the ceiling is still there, and is also not data ─────────────────────────
{
  const busy = `
    const fs = require('node:fs');
    setInterval(() => fs.appendFileSync(${JSON.stringify(auditFile)}, '{"busy":1}\\n'), 100);
  `;
  const metrics = await runProcess(spec(busy, { timeoutMs: 1200 }));
  assert.equal(metrics.broken, 'timed-out',
      'a run that is busy forever still has to be excluded rather than counted as zero turns');
  console.log('  a run that never finishes is timed-out, and marked not-a-measurement');
}

// ── a run with no agent is not a wedged browser ─────────────────────────────
//
// The two produce identical symptoms: no tool calls, no audit growth, silence
// until the heartbeat gives up. This instrument reported four such runs as
// "the browser stack is wedged — restart playwright-mcp.service" while the
// doctor was reporting the stack healthy and a real browser call
// round-tripping. An instrument that confidently names the wrong subsystem is
// worse than one that says nothing: it sends whoever reads it to go and fix
// something that was never broken.
{
  const limit = "console.log(\"You've hit your session limit · resets 12:10am (Asia/Jerusalem)\"); " +
    'setTimeout(() => {}, 30000)';
  const metrics = await runProcess(spec(limit));

  assert.equal(metrics.broken, 'no-agent',
      'the usage limit has to be told apart from a browser that stopped answering');
  assert.match(metrics.error ?? '', /session limit/, 'and the real reason has to survive into the message');
  assert.ok(!/wedged|restart/.test(metrics.error ?? ''),
      'it must not send the reader to restart a service that was never the problem');
  console.log('  a run that never got an agent says so, instead of blaming the browser');
}

await cleanup(dir);
console.log('RUNNER OK');
