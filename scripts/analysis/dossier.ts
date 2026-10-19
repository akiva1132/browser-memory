#!/usr/bin/env node
/**
 * Re-renders past runs as dossiers, from the logs they already left behind.
 *
 * Sixty runs sit in `eval/results/`, each one a real Claude session that cost
 * real money and a real slice of a usage limit, and each one recorded as four
 * numbers and the agent's closing message. The audit log was copied out beside
 * every one of them and never joined to anything. So the diagnosis those runs
 * could have supported has been on disk the whole time.
 *
 *   node scripts/dossier.ts                 # every result that has a log
 *   node scripts/dossier.ts --only stubborn # matching the file name
 *
 * Written to `eval/dossiers/`, never over the originals. The original holds the
 * prompt and the agent's own words, which exist nowhere else — overwriting
 * sixty of those to improve their formatting is not a trade worth offering.
 *
 * Runs from before the trace existed get the sections the audit log can support
 * and an explicit note on the ones it cannot. A section that could not be
 * computed must not read like a section that came back empty.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { packageRoot } from '../../src/lib/roots.ts';

import { eventsSince, oneSession, renderDossier } from '../../src/report/dossier.ts';
import type { RunFacts } from '../../src/report/dossier.ts';
import type { AuditEvent } from '../../src/lib/audit.ts';
import type { TraceEvent } from '../../src/lib/trace.ts';

const RESULTS = path.join(packageRoot, 'eval', 'results');
const OUT = path.join(packageRoot, 'eval', 'dossiers');
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined;

/** `<scenario>-<mode>-<stamp>.md`, where the stamp also names the log beside it. */
const NAME = /^(.+)-(cold|warm)-(\d{4}-.+)\.md$/;
const HEADLINE = /^(\d+)s · (\d+) turns · \$([\d.]+)/m;

/**
 * The old report, taken apart.
 *
 * Only two of its sections are irreplaceable — the prompt and what the agent
 * said — and both are free text that can contain anything, including something
 * that looks like a heading. So the split is on the known headings in order,
 * and anything unrecognised is left out rather than guessed at.
 */
function parse(text: string, scenario: string, mode: string): RunFacts {
  const section = (name: string): string | undefined => {
    const start = text.indexOf(`\n## ${name}\n`);
    if (start === -1)
      return undefined;
    const from = start + name.length + 5;
    const next = text.indexOf('\n## ', from);
    return text.slice(from, next === -1 ? undefined : next).trim() || undefined;
  };
  const headline = HEADLINE.exec(text);
  const checks = section('Checks')?.split('\n')
      .flatMap(line => {
        const match = /^- (PASS|FAIL) (.+)$/.exec(line.trim());
        return match ? [{ name: match[2]!, passed: match[1] === 'PASS' }] : [];
      });
  return {
    scenario,
    mode,
    ...(headline ? {
      seconds: Number(headline[1]), turns: Number(headline[2]), costUsd: Number(headline[3]),
    } : {}),
    ...(checks?.length ? { checks } : {}),
    prompt: section('Prompt'),
    output: section('What the agent reported'),
    error: section('Harness error'),
  };
}

/**
 * When this run started, reconstructed rather than recorded.
 *
 * A warm run works against the live store, whose audit log every gateway on the
 * machine appends to — so the copy taken at the end of a run holds days of
 * other sessions. Reading it whole made a 59-second run report 518 calls and
 * error offsets like `+5635s`, which is the sort of number that ends up in a
 * conclusion.
 *
 * Both ends are recoverable: the stamp in the file name is the moment the
 * report was written, and the headline says how long the run took. A minute of
 * slack covers the checks and the report write that sit between the two.
 */
const SLACK_MS = 60_000;
function began(stamp: string, facts: RunFacts): string | undefined {
  const ended = Date.parse(stamp.replace(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1-$2-$3T$4:$5:$6.$7Z'));
  if (Number.isNaN(ended) || facts.seconds === undefined)
    return undefined;
  return new Date(ended - facts.seconds * 1000 - SLACK_MS).toISOString();
}

const names = (await fs.readdir(RESULTS).catch(() => [] as string[]))
    .filter(name => NAME.test(name))
    .filter(name => !only || name.includes(only))
    .sort();

await fs.mkdir(OUT, { recursive: true });
let written = 0;
let withoutLog = 0;
let withTrace = 0;

for (const name of names) {
  const [, scenario, mode, stamp] = NAME.exec(name)!;
  const text = await fs.readFile(path.join(RESULTS, name), 'utf8');
  const facts = parse(text, scenario!, mode!);
  // Windowed first so a log spanning days does not offer several sessions as
  // candidates for "the last one", then narrowed to the single session that
  // actually ran — the window alone is a guess, and its slack showed up as
  // minutes of imaginary thinking time.
  const from = began(stamp!, facts);
  const audit = oneSession(await eventsSince<AuditEvent>(path.join(RESULTS, `${stamp}-audit.jsonl`), from));
  const trace = oneSession(await eventsSince<TraceEvent>(path.join(RESULTS, `${stamp}-trace.jsonl`), from));
  if (!audit.length) {
    // Named rather than skipped silently. A run with no log is usually one that
    // never made a call, which is itself the finding.
    withoutLog += 1;
    console.log(`  ${name}  — no audit log beside it`);
  }
  if (trace.length)
    withTrace += 1;
  await fs.writeFile(path.join(OUT, name), renderDossier(facts, audit, trace), 'utf8');
  written += 1;
}

console.log(`\n${written} dossier(s) in ${path.relative(process.cwd(), OUT)}`);
console.log(`  ${withTrace} with a trace, ${written - withTrace} from the audit log alone, ` +
  `${withoutLog} with neither.`);
