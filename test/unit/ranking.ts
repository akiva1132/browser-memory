/**
 * Ranking, and what becomes of a lesson that stops being true.
 *
 * Two failures that live entirely in the ordering, where nothing ever throws:
 *
 * Identifiers were tokenized after lowercasing, which erased the case
 * boundaries that are the only separators an identifier has. `getVpsList`
 * arrived as the single token `getvpslist`, so a goal of "list the vps
 * instances" overlapped the lesson that answered it by nothing at all and the
 * kind bonus decided the brief — an unrelated recipe above the exact answer.
 * The fixtures here are built so that the unrelated recipe wins on kind alone
 * the moment the seams are lost again.
 *
 * The second is that the only way to say "this is no longer true" was to delete
 * the lesson, which takes the date and the reason down with it. A superseded
 * lesson is hidden instead of erased: out of recall, never above a live lesson,
 * and still readable by whoever needs to know when the route changed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { MemoryStore, trustLabel } from '../../src/memory/store.ts';
import { matchSymptom, rank } from '../../src/memory/recall.ts';
import type { Lesson } from '../../src/types.ts';
import { cleanup, tempMemoryDir } from '../harness.ts';

const memoryDir = await tempMemoryDir('ranking');
const store = new MemoryStore(memoryDir, 'session-seed');
const today = new Date().toISOString().slice(0, 10);

// ── A. compound identifiers survive tokenization ─────────────────────────────
const PANEL = 'panel.example.com';

// A recipe outranks a fact by 2.5 on kind alone, and overlaps none of the goals
// below. Whenever it comes first, the goal matched nothing.
await store.remember(PANEL, {
  kind: 'recipe',
  title: 'Steps to export the billing invoices',
  gist: 'Open Billing, pick a month, then use the download control.',
});
await store.remember(PANEL, {
  kind: 'fact',
  title: 'getVpsList returns every server on the account',
  gist: 'One call, no paging.',
});
await store.remember(PANEL, {
  kind: 'fact',
  title: 'VPSMetrics charts the last 24 hours',
  gist: 'The widget on the overview screen.',
});
await store.remember(PANEL, {
  kind: 'landmark',
  title: 'Servers live at /api/v1/servers',
  gist: 'The table is a client-side render of that response.',
});

const panel = await store.applicable(PANEL);

{
  // The goal names the identifier in prose, which is how goals are written.
  // Pre-fix this scored 1.5 against the recipe's 4.0 and came second.
  const ranked = rank(panel, 'list the vps instances');
  assert.equal(ranked[0]?.id, 'getvpslist-returns-every-server-on-the-account',
      'a goal naming the parts of a camelCase identifier must reach the lesson titled with it');
  console.log('  "list the vps instances" finds getVpsList');
}

{
  // Splitting must not be paid for by dropping the whole word: an agent that
  // quotes the identifier is the most confident match there is.
  const ranked = rank(panel, 'getvpslist');
  assert.equal(ranked[0]?.id, 'getvpslist-returns-every-server-on-the-account',
      'the compound itself must stay a token, so an exact mention still matches');
  console.log('  the compound is kept, so an exact mention still wins');
}

{
  // The other convention: an acronym followed by a word, where the boundary is
  // before the last capital rather than after a lowercase.
  const ranked = rank(panel, 'read the vps metrics');
  assert.equal(ranked[0]?.id, 'vpsmetrics-charts-the-last-24-hours',
      'VPSMetrics must split at the acronym boundary into vps and metrics');
  console.log('  VPSMetrics splits at the acronym boundary');
}

{
  // Slashes and dots were never the problem — they fall outside the character
  // class and have always separated. Asserted so a change to the class cannot
  // quietly take them away.
  const ranked = rank(panel, 'GET /api/v1/servers');
  assert.equal(ranked[0]?.id, 'servers-live-at-api-v1-servers',
      'a path in the goal must still match the same path in a title');
  console.log('  paths still split on slashes and dots');
}

// ── B. a superseded lesson is hidden, not erased ─────────────────────────────
const LEGACY = 'legacy.example.net';
const curator = new MemoryStore(memoryDir, 'session-curator');

await store.remember(LEGACY, {
  kind: 'fast-path',
  title: 'Download the report from /exports/report.csv',
  gist: 'One GET, no UI.',
});
await store.remember(LEGACY, {
  kind: 'fact',
  title: 'Invoices are numbered per calendar year',
  gist: 'Numbering restarts every January.',
});
await store.remember(LEGACY, {
  kind: 'fix',
  title: 'The export button silently does nothing',
  gist: 'Reload with ?legacy=1 first.',
  trigger: 'export failed: request aborted',
});

const REPORT = 'download-the-report-from-exports-report-csv';
const EXPORT_FIX = 'the-export-button-silently-does-nothing';

{
  const marked = await curator.invalidate(LEGACY, REPORT, 'replaced by /v2/exports; the old path 404s since the March release');
  assert.ok(marked?.invalidated, 'invalidate must record the supersession on the lesson');
  assert.equal(marked.invalidated.at, today, 'the date it stopped holding is the point of keeping it');
  assert.equal(marked.invalidated.by, 'session-curator', 'who retired it is what makes it auditable');
  assert.match(marked.invalidated.note ?? '', /v2\/exports/, 'the reason must survive');
  assert.equal(await curator.invalidate(LEGACY, 'no-such-lesson'), undefined,
      'invalidating something that does not exist reports nothing, like forget');
  console.log(`  marked superseded: ${trustLabel(marked)}`);
}

{
  const live = await store.applicable(LEGACY);
  assert.ok(!live.some(entry => entry.id === REPORT),
      'a superseded lesson must not come back from the path every brief reads');
  assert.ok(live.some(entry => entry.id === 'invoices-are-numbered-per-calendar-year'),
      'and the lessons beside it must be untouched');

  const all = await store.applicable(LEGACY, { includeInvalidated: true });
  const kept = all.find(entry => entry.id === REPORT);
  assert.ok(kept?.invalidated, 'it is hidden, not deleted — asking for it must return it');
  assert.match(trustLabel(kept), /SUPERSEDED/, 'a reader must be told, not left to infer it from a field');
  assert.match(trustLabel(kept), new RegExp(today), 'the "held until" date has to be readable');
  assert.match(trustLabel(kept), /v2\/exports/, 'and so does the reason');
  console.log('  excluded from recall, still retrievable and still legible');
}

{
  // A goal that quotes the retired lesson almost word for word, against live
  // lessons it shares nothing with: 16.5 against 3.5 and 1.5 on score alone.
  const all = await store.applicable(LEGACY, { includeInvalidated: true });
  const ranked = rank(all, 'download the report csv');
  assert.equal(ranked.at(-1)?.id, REPORT,
      'no lexical score may lift a superseded lesson above a live one');
  assert.ok(ranked.slice(0, -1).every(entry => !entry.invalidated),
      'the live lessons come first, including the ones the goal does not touch at all');
  console.log('  a word-for-word match on a retired lesson still ranks below every live one');
}

{
  // A verbatim trigger scores 10 on its own, which is more than any penalty
  // would have been. It never reaches the matcher because recall drops it first.
  await curator.invalidate(LEGACY, EXPORT_FIX, 'the button was fixed on 2026-07-20');
  const symptom = 'export failed: request aborted';
  assert.equal(matchSymptom(await store.applicable(LEGACY), symptom).length, 0,
      'a superseded fix must not be offered for its own symptom');
  assert.ok(matchSymptom(await store.applicable(LEGACY, { includeInvalidated: true }), symptom).length > 0,
      'but the record of what used to fix it is still there to be asked for');
  console.log('  a superseded fix stops answering its own trigger');
}

{
  // Recording it again is first-hand evidence that it holds, and `remember`
  // upserts by title — without clearing the mark the lesson would stay invisible
  // no matter how many agents re-learned it.
  await store.remember(LEGACY, {
    kind: 'fast-path',
    title: 'Download the report from /exports/report.csv',
    gist: 'One GET against /v2/exports, no UI.',
  });
  const live = await store.applicable(LEGACY);
  assert.ok(live.some(entry => entry.id === REPORT),
      're-recording a superseded lesson must bring it back');
  console.log('  re-learning it ends the supersession');
}

// ── B2. files written before any of this load unchanged ──────────────────────
const OLD = 'old-format.example.org';
const oldEntry: Lesson = {
  id: 'the-search-box-needs-two-characters',
  kind: 'fact',
  title: 'The search box needs two characters',
  gist: 'Nothing happens on a single letter.',
  body: '',
  snippet: '',
  trigger: '',
  tags: ['search'],
  created: '2026-01-04',
  updated: '2026-01-04',
  verified: '2026-01-04',
  confirmed: 2,
  failed: 0,
  used: 1,
  by: 'session-old',
};
const oldFile = path.join(memoryDir, `${OLD}.json`);
await fs.mkdir(memoryDir, { recursive: true });
await fs.writeFile(
    oldFile, `${JSON.stringify({ domain: OLD, updated: '2026-01-04', entries: [oldEntry] }, null, 2)}\n`, 'utf8');

{
  assert.deepEqual(await store.entries(OLD), [oldEntry],
      'an entry written before the field existed must load exactly as it was stored');
  assert.equal((await store.applicable(OLD)).length, 1,
      'and it must count as live, since absent is what "still true" looks like on disk');

  // Rewritten by an ordinary confirmation: no absent field may be filled in
  // with a default on the way past.
  await store.report(OLD, oldEntry.id, 'worked');
  const raw = JSON.parse(await fs.readFile(oldFile, 'utf8')) as { entries: Record<string, unknown>[] };
  assert.ok(!Object.hasOwn(raw.entries[0]!, 'invalidated'),
      'a live lesson must not gain the key, so old and new files stay the same format');
  console.log('  files with no invalidated field load and round-trip unchanged');
}

// ── B3. the date a lesson stopped holding does not drift ─────────────────────
const ARCHIVE = 'archive.example.org';
const supersededEntry: Lesson = {
  ...oldEntry,
  id: 'the-dashboard-lives-at-servers',
  title: 'The dashboard lives at /servers',
  gist: 'Straight there, no menu.',
  invalidated: { at: '2026-01-15', by: 'session-old' },
};
await fs.writeFile(
    path.join(memoryDir, `${ARCHIVE}.json`),
    `${JSON.stringify({ domain: ARCHIVE, updated: '2026-01-15', entries: [supersededEntry] }, null, 2)}\n`,
    'utf8');

{
  const again = await curator.invalidate(ARCHIVE, supersededEntry.id, 'moved to /v2/servers');
  assert.equal(again?.invalidated?.at, '2026-01-15',
      're-marking must not drag "held until" forward — that date is the fact being kept');
  assert.equal(again.invalidated?.note, 'moved to /v2/servers', 'a later marking may supply the reason');

  const bare = await curator.invalidate(ARCHIVE, supersededEntry.id);
  assert.equal(bare?.invalidated?.note, 'moved to /v2/servers',
      'and a marking without one must not wipe the reason already recorded');
  console.log('  "held until" survives re-marking, and so does the reason');
}

// ── C. trust sorts; it does not subtract ────────────────────────────────────
//
// A lesson the store itself labels "treat as a hypothesis" was able to lead the
// brief, because disputed was a subtraction of 6 against an overlap worth 3 a
// word: three shared words and a twice-failed lesson was on top. The fixtures
// are built so the disputed one wins on every axis that is still arithmetic —
// more goal words, a better kind — and must still come second.
{
  const SITE = 'trust.example.com';
  const base: Lesson & { source: string } = {
    id: '', title: '', gist: '', body: '', snippet: '', trigger: '', kind: 'fact', tags: [],
    confirmed: 0, failed: 0, used: 0, created: today, updated: today, verified: today,
    by: 'session-seed', source: SITE,
  };
  const ranked = rank([
    {
      ...base, id: 'shaky', kind: 'fast-path',
      title: 'Export invoices billing download',
      gist: 'Export the invoices from billing with the download endpoint.',
      tags: ['invoices', 'billing', 'export', 'download'],
      // Twice failed is what the store calls disputed.
      failed: 2, confirmed: 0,
    },
    {
      ...base, id: 'solid', kind: 'fact',
      title: 'Invoices are under Billing',
      gist: 'The invoices live in the billing section.',
      tags: ['invoices'],
      confirmed: 3,
    },
  ], 'export the billing invoices download');

  assert.equal(ranked[0]?.id, 'solid',
      'a lesson that failed twice must not lead a brief over one that has been confirmed');
  assert.equal(ranked[1]?.id, 'shaky',
      'but it is a hypothesis, not a lie — on a site where it is all anyone knows it still shows');
  console.log('  a disputed lesson sorts below a trusted one, however well it matches');
}

// ── D. a word repeated is not a word matched twice ──────────────────────────
{
  const SITE_BASE: Lesson & { source: string } = {
    id: '', title: '', gist: '', body: '', snippet: '', trigger: '', kind: 'fact', tags: [],
    confirmed: 1, failed: 0, used: 0, created: today, updated: today, verified: today,
    by: 'session-seed', source: 'repeat.example.com',
  };
  const ranked = rank([
    {
      ...SITE_BASE, id: 'parrot',
      title: 'invoices invoices invoices',
      gist: 'invoices invoices invoices invoices',
      tags: ['invoices', 'invoices'],
    },
    {
      ...SITE_BASE, id: 'answer',
      title: 'Invoices are exported from the billing page',
      gist: 'Billing has an export control for invoices.',
      tags: ['billing'],
    },
  ], 'export invoices from billing');

  assert.equal(ranked[0]?.id, 'answer',
      'saying one goal word nine times must not beat matching three of them once');
  console.log('  overlap counts distinct words, so repetition buys nothing');
}

// ── a correction retires what it corrects, without being asked to ────────────
//
// `invalidate` was tested and unreachable: no tool called it, while the one act
// that retires a claim — re-saving a lesson under its title — overwrote the old
// text in place. Wiring it to `domain_remember` is what makes the record happen
// on the path corrections already take, with no second tool and no decision.
{
  const SITE = 'corrected.example.org';
  const author = new MemoryStore(memoryDir, 'session-author');
  await author.remember(SITE, {
    kind: 'landmark',
    title: 'The metrics screen',
    gist: 'It lives at /servers/:id/metrics.',
    body: 'Reachable from the server row.',
  });

  await author.remember(SITE, {
    kind: 'landmark',
    title: 'The metrics screen',
    gist: 'It moved to /vps/:id/insights in the March release.',
    body: 'The old route 404s.',
  });

  const live = await author.applicable(SITE);
  assert.equal(live.length, 1, 'a brief must see one lesson, not a lesson and its own history');
  assert.match(live[0]!.gist, /insights/, 'and it must be the corrected one');

  const all = await author.applicable(SITE, { includeInvalidated: true });
  const kept = all.find(entry => entry.id === 'the-metrics-screen-superseded');
  assert.ok(kept, 'the claim that was replaced is kept, under an id that can be typed');
  assert.match(kept.gist, /\/servers\/:id\/metrics/, 'holding what it said, not what replaced it');
  assert.equal(kept.invalidated?.at, today, 'dated the day it stopped holding');
  assert.equal(kept.invalidated?.by, 'session-author', 'and attributed, like every other write');
  assert.match(kept.invalidated?.note ?? '', /insights/, 'saying what replaced it');
  assert.match(trustLabel(kept), /SUPERSEDED/, 'and legible as retired to anyone who opens it');

  // Bounded: one generation, replaced rather than accumulated.
  await author.remember(SITE, {
    kind: 'landmark',
    title: 'The metrics screen',
    gist: 'It moved again, to /vps/:id/metrics.',
    body: 'Third address.',
  });
  const after = await author.applicable(SITE, { includeInvalidated: true });
  assert.equal(after.length, 2, 'a lesson corrected twice leaves one record, not one per correction');
  assert.match(after.find(entry => entry.invalidated)!.gist, /insights/,
      'and the record holds the claim most recently retired');

  // Re-asserting the same text is evidence, not a correction.
  const before = (await author.applicable(SITE, { includeInvalidated: true })).length;
  await author.remember(SITE, {
    kind: 'landmark',
    title: 'The metrics screen',
    gist: 'It moved again, to /vps/:id/metrics.',
    body: 'Third address.',
  });
  assert.equal((await author.applicable(SITE, { includeInvalidated: true })).length, before,
      'confirming a lesson unchanged must not retire anything');
  console.log('  correcting a lesson keeps what it said, once, without being asked');
}

await cleanup(memoryDir);
console.log('RANKING OK');
