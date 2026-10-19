#!/usr/bin/env node
/**
 * Where agents are suffering, and whether memory covers it.
 *
 * The store answers "what do we know". This answers the question that decides
 * what to do next: where does knowing nothing keep costing something. Both
 * halves are already on disk — `audit.jsonl` records every call the gateway
 * made and whether it failed, and the store records what was learned — so this
 * is a join, not an investigation.
 *
 *   node scripts/attention.ts [memory-dir]
 *
 * It is deliberately a report rather than a trigger. Deciding to go and map a
 * site is a decision about someone's live account, and the honest form of that
 * is a ranked list a person reads, not a crawler that starts on its own.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { packageRoot } from '../../src/lib/roots.ts';

import type { Endpoint } from '../../src/capture/apiMap.ts';
import type { Lesson } from '../../src/types.ts';
import type { Place } from '../../src/browser/places.ts';
import { PLACE_THRESHOLD } from '../../src/browser/places.ts';

const dir = path.resolve(process.argv[2] ?? path.join(packageRoot, 'memory'));

type AuditLine = { at?: string; session?: string; tool?: string; outcome?: string; args?: unknown };

type Row = {
  domain: string;
  calls: number;
  errors: number;
  sessions: Set<string>;
  lessons: number;
  endpoints: number;
  places: number;
};

const read = async <T>(file: string, pick: (parsed: unknown) => T, fallback: T): Promise<T> => {
  try {
    return pick(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    return fallback;
  }
};

/**
 * The audit log records the tool and its arguments, not the page. For calls
 * that carry a URL that is the domain; for the rest the domain is whatever the
 * last URL-carrying call established, which is how a session actually reads.
 */
function domainOf(args: unknown): string {
  const url = (args as { url?: unknown })?.url;
  if (typeof url !== 'string')
    return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const rows = new Map<string, Row>();
const rowFor = (domain: string): Row => {
  const existing = rows.get(domain);
  if (existing)
    return existing;
  const row: Row = { domain, calls: 0, errors: 0, sessions: new Set(), lessons: 0, endpoints: 0, places: 0 };
  rows.set(domain, row);
  return row;
};

const auditFiles = (await fs.readdir(dir).catch(() => [] as string[]))
    .filter(name => name === 'audit.jsonl' || name.startsWith('audit.jsonl.'));

let lines = 0;
for (const file of auditFiles) {
  const raw = await fs.readFile(path.join(dir, file), 'utf8').catch(() => '');
  let current = '';
  for (const line of raw.split('\n')) {
    if (!line.trim())
      continue;
    let event: AuditLine;
    try {
      event = JSON.parse(line) as AuditLine;
    } catch {
      // A process killed mid-write leaves one torn line. It is not a reason to
      // stop reading the rest of the log.
      continue;
    }
    lines += 1;
    const named = domainOf(event.args);
    if (named)
      current = named;
    if (!current || !event.tool?.startsWith('browser_'))
      continue;
    const row = rowFor(current);
    row.calls += 1;
    if (event.outcome === 'error')
      row.errors += 1;
    if (event.session)
      row.sessions.add(event.session);
  }
}

for (const [domain, row] of rows) {
  row.lessons = (await read<Lesson[]>(
      path.join(dir, `${domain}.json`), parsed => (parsed as { entries?: Lesson[] }).entries ?? [], [])).length;
  row.endpoints = (await read<Endpoint[]>(
      path.join(dir, 'api', `${domain}.json`), parsed => (parsed as { endpoints?: Endpoint[] }).endpoints ?? [], [])).length;
  row.places = (await read<Place[]>(
      path.join(dir, 'places', `${domain}.json`), parsed => (parsed as { places?: Place[] }).places ?? [], []))
      .filter(place => place.sessions.length >= PLACE_THRESHOLD).length;
}

/**
 * Failures cost the most, repetition multiplies them, and knowledge is what
 * makes them stop. A domain visited once that failed once is noise; a domain
 * three sessions kept failing on with nothing written down is the whole point.
 */
const painOf = (row: Row): number =>
  (row.errors * row.sessions.size) / (1 + row.lessons + row.places);

const ranked = [...rows.values()]
    .filter(row => row.calls > 0)
    .sort((a, b) => painOf(b) - painOf(a) || b.calls - a.calls);

if (!ranked.length) {
  console.log(`No browser calls recorded in ${dir} (${lines} audit lines read).`);
  process.exit(0);
}

console.log(`${lines} audit lines · ${ranked.length} domains\n`);
console.log('  pain  calls  err  sess  lessons  api  places  domain');
for (const row of ranked.slice(0, 20)) {
  const pain = painOf(row);
  console.log(
      `  ${pain.toFixed(2).padStart(4)}  ${String(row.calls).padStart(5)}  ` +
      `${String(row.errors).padStart(3)}  ${String(row.sessions.size).padStart(4)}  ` +
      `${String(row.lessons).padStart(7)}  ${String(row.endpoints).padStart(3)}  ` +
      `${String(row.places).padStart(6)}  ${row.domain}`);
}

const worst = ranked[0]!;
console.log(
    painOf(worst) > 0
      ? `\nWorst: ${worst.domain} — ${worst.errors} failed call(s) across ${worst.sessions.size} session(s), ` +
        `with ${worst.lessons} lesson(s) and ${worst.places} known place(s) on record.` +
        `\nThat is where the next lesson is worth the most.`
      : '\nNo failures on record. Nothing here needs attention.');
