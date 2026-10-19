#!/usr/bin/env node
/**
 * What a session actually left behind, as opposed to what it said it did.
 *
 * Answers one question: if another agent walked into these sites right now,
 * what would it start with that the last one had to work out? Everything here
 * is read from the store itself, so an agent that reported writing a lesson it
 * never wrote shows up as absent.
 *
 *   node scripts/learned.ts <dir> [baseline]
 *
 * With a baseline it prints only the difference, which is the useful form
 * while a chained experiment is running: point it at the shared directory and
 * at the real store it was seeded from.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { packageRoot } from '../../src/lib/roots.ts';

import type { Endpoint } from '../../src/capture/apiMap.ts';
import type { Lesson, Procedure } from '../../src/types.ts';

const [dirArg, baseArg] = process.argv.slice(2);
if (!dirArg) {
  console.error('usage: node scripts/learned.ts <dir> [baseline]');
  process.exit(1);
}
const dir = path.resolve(dirArg);
const baseline = baseArg ? path.resolve(baseArg) : path.join(packageRoot, 'memory');

const read = async <T>(file: string, pick: (parsed: unknown) => T, fallback: T): Promise<T> => {
  try {
    return pick(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    return fallback;
  }
};

const jsonFiles = async (root: string): Promise<string[]> =>
  (await fs.readdir(root).catch(() => [] as string[])).filter(name => name.endsWith('.json'));

const lessonsIn = (root: string, domain: string): Promise<Lesson[]> =>
  read(path.join(root, `${domain}.json`), parsed => (parsed as { entries?: Lesson[] }).entries ?? [], []);

const endpointsIn = (root: string, domain: string): Promise<Endpoint[]> =>
  read(path.join(root, 'api', `${domain}.json`),
      parsed => (parsed as { endpoints?: Endpoint[] }).endpoints ?? [], []);

const proceduresIn = (root: string, domain: string): Promise<Procedure[]> =>
  read(path.join(root, 'procedures', `${domain}.json`),
      parsed => (parsed as { procedures?: Procedure[] }).procedures ?? [], []);

const domains = [...new Set([
  ...(await jsonFiles(dir)).map(name => name.slice(0, -5)),
  ...(await jsonFiles(path.join(dir, 'api'))).map(name => name.slice(0, -5)),
  ...(await jsonFiles(path.join(dir, 'procedures'))).map(name => name.slice(0, -5)),
])].sort();

let newLessons = 0;
let newEndpoints = 0;
let newProcedures = 0;
const blocks: string[] = [];

for (const domain of domains) {
  const [lessons, base] = await Promise.all([lessonsIn(dir, domain), lessonsIn(baseline, domain)]);
  const known = new Set(base.map(entry => entry.id));
  const fresh = lessons.filter(entry => !known.has(entry.id));

  const [endpoints, baseEndpoints] = await Promise.all([
    endpointsIn(dir, domain), endpointsIn(baseline, domain)]);
  const knownEndpoints = new Set(baseEndpoints.map(entry => `${entry.method} ${entry.path}`));
  const freshEndpoints = endpoints.filter(entry => !knownEndpoints.has(`${entry.method} ${entry.path}`));

  const [procedures, baseProcedures] = await Promise.all([
    proceduresIn(dir, domain), proceduresIn(baseline, domain)]);
  const knownProcedures = new Set(baseProcedures.map(entry => entry.name));
  const freshProcedures = procedures.filter(entry => !knownProcedures.has(entry.name));

  if (!fresh.length && !freshEndpoints.length && !freshProcedures.length)
    continue;
  newLessons += fresh.length;
  newEndpoints += freshEndpoints.length;
  newProcedures += freshProcedures.length;

  const lines = [`\n▸ ${domain}`];
  for (const procedure of freshProcedures) {
    lines.push(`   TOOL  ${procedure.name}(${procedure.params.map(param => param.name).join(', ')}) ` +
      `· ${procedure.status} · ${procedure.description.slice(0, 70)}`);
  }
  for (const entry of fresh) {
    // Provenance matters more than the text here: an "auto:" lesson arrived
    // without anyone choosing to write it, which is the capture path that had
    // to be built precisely because the deliberate one kept not happening.
    const how = entry.by?.startsWith('auto:') ? 'auto' : 'agent';
    lines.push(`   ${how === 'auto' ? 'AUTO ' : 'WROTE'} [${entry.kind}] ${entry.title}`);
    if (entry.gist)
      lines.push(`         ${entry.gist.slice(0, 110)}`);
  }
  if (freshEndpoints.length) {
    lines.push(`   API   ${freshEndpoints.length} new endpoint(s):`);
    for (const endpoint of freshEndpoints.slice(0, 8)) {
      lines.push(`         ${endpoint.method} ${endpoint.path}` +
        `${endpoint.params.length ? ` ? ${endpoint.params.join(',')}` : ''}`);
    }
    if (freshEndpoints.length > 8)
      lines.push(`         …and ${freshEndpoints.length - 8} more`);
  }
  blocks.push(lines.join('\n'));
}

// Evidence that has been seen but has not recurred often enough to be promoted:
// the queue the next run draws from, and the reason a second pass can know
// things the first one only glimpsed.
const observations = (await fs.readFile(path.join(dir, 'observations.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as { domain: string; detector: string; signature: string }];
      } catch {
        return [];
      }
    });
const pending = new Map<string, number>();
for (const observation of observations) {
  const key = `${observation.domain} · ${observation.detector} · ${observation.signature}`;
  pending.set(key, (pending.get(key) ?? 0) + 1);
}
const waiting = [...pending.entries()].filter(([, count]) => count === 1);

console.log(`what ${path.basename(dir)} knows that ${path.basename(baseline)} did not\n` + '─'.repeat(72));
console.log(blocks.join('\n') || '\n  (nothing new yet)');
console.log(`\n${'─'.repeat(72)}`);
console.log(
    `${newProcedures} new callable tool(s) · ${newLessons} new lesson(s) · ${newEndpoints} new endpoint(s)`);
if (waiting.length) {
  console.log(`${waiting.length} observation(s) seen once, waiting for a second sighting to be promoted:`);
  for (const [key] of waiting.slice(0, 6))
    console.log(`   ${key.slice(0, 100)}`);
}
