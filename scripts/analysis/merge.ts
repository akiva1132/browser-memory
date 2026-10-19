#!/usr/bin/env node
/**
 * Promotes what an experiment learned into the real store.
 *
 * A chained eval run produces genuine knowledge — the technique for writing
 * into a canvas-rendered Google Doc came out of one — and it lands in a
 * directory nobody reads. This moves it across.
 *
 *   node scripts/merge.ts <from> [into]
 *
 * Only ever adds. An entry whose id already exists in the destination is left
 * alone, because the destination's version carries its own trust record: how
 * often it has been confirmed, how often it failed, when it was last verified.
 * Overwriting that with a fresh copy from an experiment would erase the very
 * evidence that makes a lesson worth trusting.
 *
 * Takes the same locks the gateway takes, so this is safe to run while a
 * session is live.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { packageRoot } from '../../src/lib/roots.ts';

import { withLock } from '../../src/lib/lock.ts';
import type { Endpoint } from '../../src/capture/apiMap.ts';
import type { Lesson, Procedure } from '../../src/types.ts';

const [fromArg, intoArg] = process.argv.slice(2);
if (!fromArg) {
  console.error('usage: node scripts/merge.ts <from> [into]');
  process.exit(1);
}
const from = path.resolve(fromArg);
const into = intoArg ? path.resolve(intoArg) : path.join(packageRoot, 'memory');

const readJson = async <T>(file: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

const writeJson = async (file: string, value: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
};

const domainsIn = async (dir: string): Promise<string[]> =>
  (await fs.readdir(dir).catch(() => [] as string[]))
      .filter(name => name.endsWith('.json') && name !== 'tabs.json')
      .map(name => name.slice(0, -5));

const today = (): string => new Date().toISOString().slice(0, 10);

let addedLessons = 0;
let addedEndpoints = 0;
let addedProcedures = 0;

// ── lessons ─────────────────────────────────────────────────────────────────
for (const domain of await domainsIn(from)) {
  const source = await readJson<{ entries?: Lesson[] }>(path.join(from, `${domain}.json`), {});
  const incoming = source.entries ?? [];
  if (!incoming.length)
    continue;

  await withLock(domain, path.join(into, `${domain}.lock`), async () => {
    await fs.mkdir(into, { recursive: true });
    const file = path.join(into, `${domain}.json`);
    const current = await readJson<{ entries?: Lesson[] }>(file, {});
    const entries = current.entries ?? [];
    const known = new Set(entries.map(entry => entry.id));
    const fresh = incoming.filter(entry => !known.has(entry.id));
    if (!fresh.length)
      return;
    for (const entry of fresh) {
      console.log(`  + ${domain}  [${entry.kind}] ${entry.title}`);
      entries.push(entry);
      addedLessons += 1;
    }
    await writeJson(file, { domain, updated: today(), entries });
  });
}

// ── the API map ─────────────────────────────────────────────────────────────
for (const domain of await domainsIn(path.join(from, 'api'))) {
  const source = await readJson<{ endpoints?: Endpoint[] }>(path.join(from, 'api', `${domain}.json`), {});
  const incoming = source.endpoints ?? [];
  if (!incoming.length)
    continue;

  await withLock(`api:${domain}`, path.join(into, 'api', `${domain}.lock`), async () => {
    await fs.mkdir(path.join(into, 'api'), { recursive: true });
    const file = path.join(into, 'api', `${domain}.json`);
    const current = await readJson<{ endpoints?: Endpoint[] }>(file, {});
    const endpoints = current.endpoints ?? [];
    const byKey = new Map(endpoints.map(entry => [`${entry.method} ${entry.path}`, entry]));
    let added = 0;
    for (const endpoint of incoming) {
      const key = `${endpoint.method} ${endpoint.path}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, endpoint);
        added += 1;
        continue;
      }
      // Two observations of the same endpoint are more evidence for it, and
      // the union of the parameter names is strictly better than either.
      existing.seen += endpoint.seen;
      existing.params = [...new Set([...existing.params, ...endpoint.params])].sort();
      if (endpoint.lastSeen > existing.lastSeen)
        existing.lastSeen = endpoint.lastSeen;
    }
    if (added)
      console.log(`  + ${domain}  ${added} endpoint(s)`);
    addedEndpoints += added;
    await writeJson(file, {
      domain,
      updated: today(),
      endpoints: [...byKey.values()].sort((a, b) => b.seen - a.seen || a.path.localeCompare(b.path)),
    });
  });
}

// ── procedures ──────────────────────────────────────────────────────────────
for (const domain of await domainsIn(path.join(from, 'procedures'))) {
  const source = await readJson<{ procedures?: Procedure[] }>(
      path.join(from, 'procedures', `${domain}.json`), {});
  const incoming = source.procedures ?? [];
  if (!incoming.length)
    continue;

  await withLock(`proc:${domain}`, path.join(into, 'procedures', `${domain}.lock`), async () => {
    await fs.mkdir(path.join(into, 'procedures'), { recursive: true });
    const file = path.join(into, 'procedures', `${domain}.json`);
    const current = await readJson<{ procedures?: Procedure[] }>(file, {});
    const procedures = current.procedures ?? [];
    const known = new Set(procedures.map(entry => entry.name));
    const fresh = incoming.filter(entry => !known.has(entry.name));
    if (!fresh.length)
      return;
    for (const procedure of fresh) {
      console.log(`  + ${domain}  TOOL ${procedure.name} (${procedure.status})`);
      procedures.push(procedure);
      addedProcedures += 1;
    }
    await writeJson(file, { domain, updated: today(), procedures });
  });
}

console.log(
    `\n${addedLessons} lesson(s), ${addedEndpoints} endpoint(s), ${addedProcedures} procedure(s) ` +
    `merged into ${path.relative(process.cwd(), into) || into}. Nothing was overwritten.`);
