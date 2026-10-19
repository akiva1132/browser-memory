#!/usr/bin/env node
/**
 * Runs scenarios through a real headless Claude session and reports what it
 * cost. The interesting mode is `--compare`: the same scenario twice, once
 * against an empty memory and once against the real one, so "the memory helps"
 * becomes a number instead of a belief.
 *
 *   node eval/run.ts                     every scenario, warm, no side effects
 *   node eval/run.ts --compare           cold vs warm, with the delta
 *   node eval/run.ts --only unknown-site
 *   node eval/run.ts --side-effects      include scenarios that send or download
 *   node eval/run.ts --chain --repeat 3  one shared memory, so run 3 inherits runs 1-2
 *   node eval/run.ts --memory <dir>      start every run from that snapshot, A/B style
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gatewayEntry, packageRoot } from '../src/lib/roots.ts';

import { Harness } from '../test/harness.ts';
import { eventsSince, renderDossier } from '../src/report/dossier.ts';
import type { AuditEvent } from '../src/lib/audit.ts';
import type { TraceEvent } from '../src/lib/trace.ts';
import { runProcess } from './runner.ts';
import type { Metrics } from './runner.ts';
import { SCENARIOS, byId } from './scenarios.ts';
import type { Scenario } from './checks.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL_MEMORY = path.join(packageRoot, 'memory');
/** Kept, not discarded: without the agent's own words a failure is unreadable. */
const RESULTS = path.join(here, 'results');
/** Where a chained experiment accumulates, in the open rather than in /tmp. */
const CHAIN_MEMORY = path.join(here, 'chain-memory');
type Outcome = {
  scenario: Scenario;
  mode: 'cold' | 'warm';
  metrics: Metrics;
  checks: { name: string; passed: boolean }[];
};

/**
 * The gateway, and nothing else.
 *
 * `--allowedTools` turned out to be an auto-approve list rather than a
 * restriction: every MCP server on this machine was loaded into every run, and
 * a scenario meant to be done through the browser was answered by calling
 * Hostinger's REST API instead — twice, in both arms, while reporting the
 * browser half as impossible. `--strict-mcp-config` with this file is what
 * actually makes a run measure what it claims to.
 */
async function soleServerConfig(workdir: string, memoryDir: string): Promise<string> {
  const file = path.join(workdir, 'mcp.json');
  await fs.writeFile(file, JSON.stringify({
    mcpServers: {
      browser: {
        type: 'stdio',
        command: 'node',
        args: [gatewayEntry],
        // Spelled out rather than inherited: this block replaces the child's
        // environment, so anything the gateway reads has to be named here.
        env: { BROWSER_MEMORY_DIR: memoryDir },
      },
    },
  }), 'utf8');
  return file;
}

/**
 * Which memory a run gets, and the default is the product's own behaviour: the
 * real store, learned into and carried forward. A benchmark run is a real agent
 * doing real work on real sites, and the lessons it leaves are true ones — the
 * API map for Cloudflare arrived exactly that way. Withholding them by default
 * would mean the thing being measured is not the thing that ships.
 *
 * Isolation is the measuring instrument's need, not the product's. Repeating a
 * scenario for a median only works if every repetition starts from the same
 * state, otherwise the samples are a rising sequence and the median of them
 * means nothing. So repetition and comparison opt into a copy, loudly.
 *
 * Chained runs share one directory seeded from the real store: accumulation is
 * the whole point of that mode, and it stays out of the live store because a
 * deliberately odd experiment should not permanently reshape what the product
 * knows.
 */
let chainedMemory: string | undefined;

async function memoryFor(mode: 'cold' | 'warm'): Promise<string> {
  if (mode === 'cold')
    return fs.mkdtemp(path.join(os.tmpdir(), 'eval-memory-cold-'));
  if (chain) {
    if (!chainedMemory) {
      // Inside the repo, not in /tmp. A chained experiment produces real
      // knowledge — the technique for writing into a canvas-rendered Google
      // Doc came out of one — and putting that somewhere invisible and
      // self-deleting means nobody reads it and the machine eventually eats
      // it. It lives here, watchable while the run is still going.
      chainedMemory = CHAIN_MEMORY;
      await fs.rm(chainedMemory, { recursive: true, force: true });
      // Seeded, not empty: a chained experiment starts from what is actually
      // known, the way any real session does.
      await fs.cp(REAL_MEMORY, chainedMemory, { recursive: true });
    }
    return chainedMemory;
  }
  const source = memorySource ?? REAL_MEMORY;
  // A plain run against the live store learns for real, which is the point of
  // it. A run against a named snapshot never writes back to that snapshot —
  // the whole reason to name one is to compare arms that start identically.
  if (!isolated && !memorySource)
    return REAL_MEMORY;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-memory-warm-'));
  await fs.cp(source, dir, { recursive: true });
  return dir;
}

async function runOnce(scenario: Scenario, mode: 'cold' | 'warm'): Promise<Outcome> {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), `eval-${scenario.id}-`));
  // Cold means the agent has no accumulated knowledge — the honest baseline the
  // warm run is measured against.
  const memoryDir = await memoryFor(mode);

  // A newline, not a trailing prompt: without it this line sits in the pipe
  // buffer and a ten-minute run looks indistinguishable from a hung one.
  console.log(`  ${mode} run started, up to ${Math.round(scenario.timeoutMs / 60000)} min…`);
  /*
   * Marks where this run's share of the logs begins.
   *
   * Both logs are appended to by every gateway using the directory, and a
   * chained experiment deliberately reuses one across runs — so run two's
   * dossier would otherwise open with run one's calls and credit them to the
   * wrong arm.
   */
  const startedAt = new Date().toISOString();
  const mcpConfig = await soleServerConfig(workdir, memoryDir);
  const metrics = await runProcess({
    command: 'claude',
    args: [
      '-p', scenario.prompt,
      '--output-format', 'json',
      '--strict-mcp-config',
      '--mcp-config', mcpConfig,
      '--allowedTools', ...scenario.allowedTools,
    ],
    cwd: workdir,
    env: {
      ...process.env,
      BROWSER_MEMORY_DIR: memoryDir,
      // Names the one feature this arm goes without, so an addition is measured
      // against its own absence instead of argued about. Absent by default:
      // what ships must not depend on an environment variable being set.
      ...(without ? { BROWSER_MEMORY_WITHOUT: without } : {}),
    },
    timeoutMs: scenario.timeoutMs,
    auditFile: path.join(memoryDir, 'audit.jsonl'),
  });

  // Only opened when a scenario actually needs to look at the world, and given
  // a memory directory of its own.
  //
  // This used to be the real store, which quietly made every isolated run a
  // liar: a chained experiment would leave the checker's own navigation in the
  // audit log and the API map of the store it was supposed to be leaving alone.
  // The place map is what made it visible — the checker's route to a page
  // became a place agents had reportedly been to.
  let harness: Harness | undefined;
  let checkMemory: string | undefined;
  const browser = async (tool: string, args: Record<string, unknown>): Promise<string> => {
    checkMemory ??= await fs.mkdtemp(path.join(os.tmpdir(), 'eval-checks-'));
    harness ??= await Harness.start(checkMemory);
    return harness.text(tool, args);
  };

  const checks = [];
  for (const check of scenario.checks) {
    const passed = await check.run({ workdir, output: metrics.output, browser, memoryDir })
        .catch(() => false);
    checks.push({ name: check.name, passed });
  }
  await harness?.close().catch(() => {});
  if (checkMemory)
    await fs.rm(checkMemory, { recursive: true, force: true }).catch(() => {});

  // The transcript outlives the run. A green result nobody can read is how a
  // scenario once "passed" while doing none of what it claimed.
  await fs.mkdir(RESULTS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.writeFile(
      path.join(RESULTS, `${scenario.id}-${mode}-${stamp}.md`),
      renderDossier({
        scenario: scenario.id, mode, prompt: scenario.prompt, output: metrics.output,
        seconds: metrics.seconds, turns: metrics.turns, costUsd: metrics.costUsd,
        checks, broken: metrics.broken, error: metrics.error,
      }, await eventsSince<AuditEvent>(path.join(memoryDir, 'audit.jsonl'), startedAt),
      await eventsSince<TraceEvent>(path.join(memoryDir, 'trace.jsonl'), startedAt)),
      'utf8');
  const passed = checks.filter(check => check.passed).length;
  if (metrics.broken) {
    // Deliberately not formatted like the others. A broken instrument that
    // prints in the same shape as a result is how three of them in a row went
    // unnoticed for half an hour.
    console.log(`  ${mode.padEnd(4)} ✖ ${metrics.broken.toUpperCase()} after ${metrics.seconds}s — NOT A MEASUREMENT`);
    console.log(`       ${metrics.error}`);
  } else {
    console.log(
      `  ${mode.padEnd(4)} ${metrics.ok ? 'ran' : 'FAILED'} · ${metrics.seconds}s · ${metrics.turns} turns · ` +
      `$${metrics.costUsd.toFixed(2)} · cache-in ${Math.round(metrics.cacheCreationTokens / 1000)}k/` +
      `read ${Math.round(metrics.cacheReadTokens / 1000)}k · out ${metrics.outputTokens} · ` +
      `checks ${passed}/${checks.length}`);
  }

  if (metrics.error)
    console.log(`       ! ${metrics.error.split('\n')[0]}`);
  for (const check of checks.filter(check => !check.passed))
    console.log(`       ✗ ${check.name}`);

  /*
   * The audit log is kept even when the store it came from is thrown away.
   *
   * It is the only record of what happened below the agent's narration — every
   * call, its outcome and how long it took — and an isolated run used to delete
   * it along with the temporary store. That left a comparison able to see
   * totals and nothing else, so a question like "did this arm spend less time
   * on clicks that failed" could not be asked at all, which is exactly the
   * question an A/B on the failure path exists to answer.
   */
  await fs.copyFile(path.join(memoryDir, 'audit.jsonl'), path.join(RESULTS, `${stamp}-audit.jsonl`))
      .catch(() => {});
  // The trace beside it, for the same reason: the dossier is rendered now, but a
  // question nobody has thought of yet can only be asked of the raw events.
  await fs.copyFile(path.join(memoryDir, 'trace.jsonl'), path.join(RESULTS, `${stamp}-trace.jsonl`))
      .catch(() => {});

  await fs.rm(workdir, { recursive: true, force: true });
  // Never the real store, and never the chained one — that directory is the
  // experiment, and deleting it between runs would delete what is being measured.
  if (memoryDir !== REAL_MEMORY && memoryDir !== chainedMemory)
    await fs.rm(memoryDir, { recursive: true, force: true });
  return { scenario, mode, metrics, checks };
}

const args = process.argv.slice(2);
const compare = args.includes('--compare');
const withSideEffects = args.includes('--side-effects');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex === -1 ? undefined : args[onlyIndex + 1];
/**
 * Every run in this invocation shares one memory directory, so later runs
 * inherit what earlier ones learned. This is how "the second time should be
 * faster" gets measured; it makes the runs deliberately non-independent, which
 * is why nothing else defaults to it.
 */
const chain = args.includes('--chain');
/**
 * Where a warm run starts from, when that should not be the live store.
 *
 * This is what makes an A/B possible at all. To ask what one part of memory is
 * worth, both arms have to begin from the same snapshot with only that part
 * differing — and until now the only warm source was the real store, so the
 * question could not be put. Each run still gets its own copy, so repeats stay
 * independent even though they share a starting point.
 */
const memoryIndex = args.indexOf('--memory');
const memorySource = memoryIndex === -1 ? undefined : path.resolve(args[memoryIndex + 1] ?? '');
/**
 * Turns one feature off for this whole invocation, so the same scenario can be
 * run with and without it and the two compared. The review's charge against the
 * first round was that seven features shipped and one was measured; this is the
 * lever that makes the other six answerable.
 */
const withoutIndex = args.indexOf('--without');
const without = withoutIndex === -1 ? undefined : args[withoutIndex + 1];
const repeatIndex = args.indexOf('--repeat');
const repeat = repeatIndex === -1 ? 1 : Math.max(1, Number(args[repeatIndex + 1]) || 1);
/**
 * A comparison or a repeated sample needs every run to start from the same
 * state, so those work on a copy. A plain run does not, and learns for real.
 */
const isolated = compare || repeat > 1;

/**
 * Median, not mean: one run that stalls on a slow page load drags an average
 * far enough to invent an effect that is not there.
 */
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : ((sorted[middle - 1]! + sorted[middle]!) / 2);
};

/** The spread is the part that says whether a difference is worth believing. */
const spread = (values: number[], digits = 0): string =>
  values.length < 2
    ? ''
    : ` (${Math.min(...values).toFixed(digits)}–${Math.max(...values).toFixed(digits)})`;

// A comma-separated list, in order, duplicates allowed: running the same
// scenario twice and then a variant of it is exactly the shape of a
// "does it get faster, and does that survive a change of subject" experiment.
const selected = only
  ? only.split(',').map(id => byId(id.trim()))
      .filter((scenario): scenario is Scenario => Boolean(scenario))
  : SCENARIOS.filter(scenario => withSideEffects || !scenario.sideEffects);

if (only && selected.length !== only.split(',').length) {
  const known = new Set(SCENARIOS.map(scenario => scenario.id));
  console.error(`Unknown scenario(s): ${only.split(',').map(id => id.trim()).filter(id => !known.has(id)).join(', ')}`);
  process.exit(1);
}

if (!selected.length) {
  console.error(only ? `No scenario "${only}".` : 'Nothing selected.');
  process.exit(1);
}

console.log(
    `${selected.length} scenario(s)${compare ? ', cold vs warm' : ', warm'}` +
    `${repeat > 1 ? `, ${repeat}× each` : ''}`);
console.log(
    chain
      ? 'memory: one shared copy, seeded from the real store — every run inherits the ones before it'
      : memorySource
        ? `memory: a fresh copy per run of ${path.relative(process.cwd(), memorySource)} — that snapshot is never written to`
        : isolated
          ? 'memory: a fresh copy per run, so repetitions are comparable — nothing is learned for keeps'
          : `memory: the real store at ${path.relative(process.cwd(), REAL_MEMORY)} — this run learns for keeps\n`);

let outcomes: Outcome[] = [];
for (const scenario of selected) {
  console.log(`▸ ${scenario.id} — ${scenario.title}`);
  console.log(`  ${scenario.tests}`);
  if (scenario.needsAuth.length)
    console.log(`  needs a live session on: ${scenario.needsAuth.join(', ')}`);
  for (let round = 1; round <= repeat; round++) {
    if (repeat > 1)
      console.log(`  — round ${round}/${repeat}`);
    if (compare)
      outcomes.push(await runOnce(scenario, 'cold'));
    outcomes.push(await runOnce(scenario, 'warm'));
    // Two in a row means the stack is wedged, not that the work is hard.
    // Continuing from here spends ten minutes per run to learn nothing, which
    // is exactly what happened once and must not happen quietly again.
    const recent = outcomes.slice(-2);
    if (recent.length === 2 && recent.every(outcome => outcome.metrics.broken)) {
      console.log(
          `\n  ✖ two broken runs in a row — stopping rather than burning ` +
          `${(repeat - round) * Math.round(scenario.timeoutMs / 60000)} more minutes on a wedged stack.` +
          `\n    systemctl --user restart playwright-mcp.service, then run this again.`);
      break;
    }
  }
  console.log('');
}

const passed = (outcome: Outcome): boolean =>
  outcome.metrics.ok && outcome.checks.every(check => check.passed);

console.log('─'.repeat(72));

// Said before anything else, because every number below is computed without
// these and a reader who misses that is reading a median of a smaller sample
// than the one they asked for.
const brokenRuns = outcomes.filter(outcome => outcome.metrics.broken);
if (brokenRuns.length) {
  console.log(
      `✖ ${brokenRuns.length} of ${outcomes.length} run(s) never measured anything ` +
      `(${[...new Set(brokenRuns.map(outcome => outcome.metrics.broken))].join(', ')}). ` +
      `They are excluded from everything below.\n`);
}
outcomes = outcomes.filter(outcome => !outcome.metrics.broken);
if (!outcomes.length) {
  // The advice has to match the diagnosis. "Restart the browser stack" was
  // printed unconditionally, including through four runs that failed because
  // no agent ever started — sending the reader to restart a service the doctor
  // was reporting healthy.
  const noAgent = brokenRuns.some(outcome => outcome.metrics.broken === 'no-agent');
  console.log(noAgent
    ? 'Nothing left to report, and nothing here was about the browser: no agent ran.\n' +
      'Wait for the limit to reset and run it again — the scenario and the stack are untouched.'
    : 'Nothing left to report. Check `npm run doctor` first: if it is green the browser was fine\n' +
      'and the agent never got going, which restarting will not fix.');
  process.exit(1);
}

if (chain) {
  // Order is the result here, not a median: the question is whether run 2 beat
  // run 1 on the same work, and whether run 3 kept any of it on different work.
  console.log('Runs share one memory, in order. Each row inherits everything above it.\n');
  console.log('#  scenario                       time   turns    cost   checks');
  outcomes.forEach((outcome, index) => {
    const { metrics, checks } = outcome;
    const ok = checks.filter(check => check.passed).length;
    console.log(
      `${String(index + 1).padEnd(3)}${outcome.scenario.id.padEnd(30)} ` +
      `${String(metrics.seconds).padStart(4)}s ${String(metrics.turns).padStart(6)} ` +
      `${`$${metrics.costUsd.toFixed(2)}`.padStart(7)}   ${ok}/${checks.length}` +
      `${metrics.ok ? '' : '  (session failed)'}`);
  });
  const first = outcomes[0]?.metrics;
  const second = outcomes[1]?.metrics;
  if (first && second && first.turns) {
    const change = Math.round(((second.turns - first.turns) / first.turns) * 100);
    console.log(
      `\nSecond pass over the same work: ${first.turns} → ${second.turns} turns ` +
      `(${change > 0 ? '+' : ''}${change}%), ${first.seconds}s → ${second.seconds}s.`);
  }
} else if (compare) {
  const delta = (before: number, after: number): string => {
    if (!before)
      return 'n/a';
    const change = Math.round(((after - before) / before) * 100);
    return `${change > 0 ? '+' : ''}${change}%`;
  };

  for (const scenario of selected) {
    const of = (mode: 'cold' | 'warm', pick: (metrics: Metrics) => number): number[] =>
      outcomes
          .filter(outcome => outcome.scenario.id === scenario.id && outcome.mode === mode)
          .map(outcome => pick(outcome.metrics));

    console.log(`${scenario.id}${repeat > 1 ? `  — median of ${repeat}, range in brackets` : ''}\n`);
    const rows: [string, (metrics: Metrics) => number, number][] = [
      ['seconds', metrics => metrics.seconds, 0],
      ['turns', metrics => metrics.turns, 0],
      ['cost $', metrics => metrics.costUsd, 2],
      ['cache read k', metrics => metrics.cacheReadTokens / 1000, 0],
    ];
    for (const [label, pick, digits] of rows) {
      const cold = of('cold', pick);
      const warm = of('warm', pick);
      if (!warm.length)
        continue;
      const coldPart = cold.length
        ? `${median(cold).toFixed(digits)}${spread(cold, digits)} → `
        : '';
      console.log(
        `  ${label.padEnd(13)}${coldPart}${median(warm).toFixed(digits)}${spread(warm, digits)}` +
        `${cold.length ? `   ${delta(median(cold), median(warm))}` : ''}`);
    }
    // Overlapping ranges mean the runs cannot be told apart, whatever the
    // medians say. Stating it here stops a difference of one turn from being
    // reported as an improvement.
    const coldTurns = of('cold', metrics => metrics.turns);
    const warmTurns = of('warm', metrics => metrics.turns);
    if (repeat > 1 && coldTurns.length && Math.min(...coldTurns) <= Math.max(...warmTurns))
      console.log(`\n  ! The turn ranges overlap — these runs are not distinguishable at ${repeat} samples.`);
    console.log('');
  }
  console.log('A warm run that is not cheaper or shorter means the memory is not earning its place.');
} else {
  for (const outcome of outcomes) {
    console.log(
      `${passed(outcome) ? 'PASS' : 'FAIL'}  ${outcome.scenario.id.padEnd(28)} ` +
      `${outcome.metrics.seconds}s · ${outcome.metrics.turns} turns · $${outcome.metrics.costUsd.toFixed(2)}`);
  }
}

const failures = outcomes.filter(outcome => !passed(outcome));
console.log(`\n${outcomes.length - failures.length}/${outcomes.length} run(s) fully passed.`);
process.exit(failures.length ? 1 : 0);
