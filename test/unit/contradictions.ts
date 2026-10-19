/**
 * Curation finding lessons that cannot both be true.
 *
 * The duplicate detector was the whole of curation for a while, and it finds
 * the cheaper problem: two lessons saying one thing cost tokens, and the agent
 * that reads both still ends up in the right place. A contradiction is the
 * expensive one — it sends the agent to the wrong place carrying the store's
 * own authority, and reading both halves does not say which half is wrong.
 *
 * So the assertions here are as much about what must *not* be reported. A
 * category that is supposed to earn the reader's attention ahead of everything
 * else stops earning it the first time it is padded with a pair that is
 * perfectly consistent — "POST there is rejected" and "GET there returns the
 * list" are both true at once, and so is a dead end naming a route the site was
 * never seen calling.
 */
import assert from 'node:assert/strict';

import { analyze } from '../../src/memory/curate.ts';
import { renderCuration } from '../../src/memory/curateRender.ts';
import type { Contradiction, CurationTarget } from '../../src/memory/curate.ts';
import type { Endpoint } from '../../src/capture/apiMap.ts';
import type { Lesson, Procedure } from '../../src/types.ts';

const DOMAIN = 'panel.example.com';
const today = new Date().toISOString().slice(0, 10);

const lesson = (fields: Pick<Lesson, 'id' | 'kind' | 'title'> & Partial<Lesson>): Lesson => ({
  gist: '', body: '', snippet: '', trigger: '', tags: [],
  created: today, updated: today, verified: today,
  confirmed: 1, failed: 0, used: 1,
  ...fields,
});

const endpoint = (method: string, path: string): Endpoint =>
  ({ method, path, params: [], seen: 4, firstSeen: today, lastSeen: today, status: 200 });

const target = (entries: Lesson[], endpoints: Endpoint[] = []): CurationTarget =>
  ({ domain: DOMAIN, entries, procedures: [], endpoints });

const conflicts = (entries: Lesson[], endpoints: Endpoint[] = []): Contradiction[] =>
  analyze(target(entries, endpoints), []).contradictions;

const kinds = (found: Contradiction[]): string[] => found.map(item => item.kind).sort();

// ── the fixtures, reused by the render at the end ────────────────────────────

const deadEnd = lesson({
  id: 'export-hangs', kind: 'dead-end',
  title: 'The bulk export endpoint never returns',
  gist: 'GET /api/v2/reports/export hangs and then times out. Download from the UI instead.',
});
const fastPath = lesson({
  id: 'export-returns-json', kind: 'fast-path',
  title: 'GET /api/v2/reports/export returns data directly',
  gist: 'Fetching /api/v2/reports/export from a page on the site comes back with a JSON object.',
});

const invoicesWork = lesson({
  id: 'invoices-page-at-50', kind: 'fact',
  title: 'The invoice list endpoint works and pages at 50',
  gist: '/api/billing/v1/customer/invoices returns 50 rows per request.',
});
const invoicesForbidden = lesson({
  id: 'invoices-forbidden', kind: 'fact',
  title: 'The invoice list endpoint is forbidden',
  gist: '/api/billing/v1/customer/invoices answers 403 whatever the account.',
});

const searchByPost = lesson({
  id: 'search-by-post', kind: 'recipe',
  title: 'Search with POST /api/v1/search',
  gist: 'POST /api/v1/search with a JSON body comes back with the matches.',
});
const searchByGet = lesson({
  id: 'search-by-get', kind: 'fast-path',
  title: 'GET /api/v1/search?q= returns the matches',
  gist: 'Fetching GET /api/v1/search with a q parameter is the fastest way to search.',
});

const imaginedApi = lesson({
  id: 'graphql-one-call', kind: 'fast-path',
  title: 'POST /api/graphql answers everything in one call',
  gist: 'Fetching /api/graphql with a query returns the whole dashboard at once.',
  // Never confirmed by anyone. That, and not the silence on its own, is what
  // makes it worth questioning.
  confirmed: 0, used: 0,
});
const realPlace = lesson({
  id: 'billing-screen', kind: 'landmark',
  title: 'Billing lives at /dashboard/billing/invoices',
  gist: 'Navigate straight there instead of clicking through the menu.',
});

const OBSERVED = [
  endpoint('GET', '/api/v2/reports/export'),
  endpoint('GET', '/api/billing/v1/customer/invoices'),
  endpoint('GET', '/api/v1/search'),
];

// ── contradictions are a category of their own, not a flavour of duplicate ───
{
  const findings = analyze(target([deadEnd, fastPath]), []);
  assert.ok(Array.isArray(findings.contradictions),
      'analyze must report contradictions separately from duplicates — merging is the wrong fix for them');
  console.log('  analyze reports contradictions as their own finding');
}

// ── a dead end naming what a fast path recommends ────────────────────────────
{
  const found = conflicts([deadEnd, fastPath]);
  assert.equal(found.length, 1, `one conflict about one route, got ${JSON.stringify(kinds(found))}`);
  assert.equal(found[0]!.kind, 'dead-end-vs-fast-path');
  assert.equal(found[0]!.path, '/api/v2/reports/export', 'the route is what makes the two comparable');
  assert.deepEqual([found[0]!.a.id, found[0]!.b?.id], ['export-hangs', 'export-returns-json'],
      'the warning comes first: it is the one that stops work happening');
  console.log(`  dead end vs fast path on ${found[0]!.path}`);
}

// ── opposite advice from two lessons whose kind carries no verdict ───────────
{
  const found = conflicts([invoicesWork, invoicesForbidden]);
  assert.equal(found.length, 1, `two facts about one endpoint disagree, got ${JSON.stringify(kinds(found))}`);
  assert.equal(found[0]!.kind, 'opposite-advice');
  assert.equal(found[0]!.a.id, 'invoices-forbidden', 'a 403 is the claim that reads as a warning');
  console.log(`  opposite advice on ${found[0]!.path}`);
}

// ── the same route offered under two different verbs ─────────────────────────
{
  const found = conflicts([searchByPost, searchByGet]);
  assert.equal(found.length, 1, `one route, two verbs, got ${JSON.stringify(kinds(found))}`);
  assert.equal(found[0]!.kind, 'method-mismatch');
  assert.equal(found[0]!.path, '/api/v1/search', 'the query string is per-call and must not split the route');
  assert.match(found[0]!.detail, /POST/);
  assert.match(found[0]!.detail, /GET/);
  console.log(`  method mismatch on ${found[0]!.path}`);
}

// ── different verbs plus opposite advice is not a disagreement ───────────────
//
// The false positive that would ruin the category: a dead end about POST and a
// fast path about GET on one route are both true, and reporting them teaches
// the reader to skim the section that was meant to be read first.
{
  const rejected = lesson({
    id: 'orders-post-rejected', kind: 'dead-end',
    title: 'POST /api/v1/orders is rejected',
    gist: 'POST /api/v1/orders always answers 405. Orders are only created through the UI.',
  });
  const listed = lesson({
    id: 'orders-get-lists', kind: 'fast-path',
    title: 'GET /api/v1/orders lists them all',
    gist: 'GET /api/v1/orders returns every order in one response.',
  });
  assert.deepEqual(conflicts([rejected, listed]), [],
      'one route can reject a verb and serve another; that is the site working as designed');
  console.log('  a rejected verb alongside a working one is left alone');
}

// ── an endpoint the site was watched and never seen calling ──────────────────
{
  const found = conflicts([imaginedApi, realPlace], OBSERVED);
  assert.equal(found.length, 1, `only the unobserved endpoint, got ${JSON.stringify(found.map(i => i.path))}`);
  assert.equal(found[0]!.kind, 'unobserved');
  assert.equal(found[0]!.path, '/api/graphql');
  assert.equal(found[0]!.b, undefined, 'the other side is the traffic, not a second lesson');
  console.log(`  ${found[0]!.path} is cited but was never in the captured traffic`);

  // A page is not an endpoint. The map filters ordinary routes out on the way
  // in, so checking one against it would report every page as imaginary.
  assert.ok(!found.some(item => item.path.startsWith('/dashboard')),
      'a landmark pointing at a page must not be measured against the API map');
}

// ── a lesson that has worked is not made suspect by silence ──────────────────
//
// Straight from the first real corpus. hPanel's metrics endpoint is missing
// from the captured traffic — nobody opened the page that calls it — and the
// lesson describing it had been confirmed by an agent that saw the 422 with its
// own eyes. Reporting that as a contradiction was the check indicting the
// store's best knowledge on the strength of nothing happening.
{
  const proven = lesson({
    ...imaginedApi, id: 'graphql-proven', confirmed: 3, used: 5,
  });
  assert.deepEqual(conflicts([proven, realPlace], OBSERVED), [],
      'absence from the map is weak evidence, and confirmation outweighs it');
  console.log('  an endpoint that has worked is not questioned for being absent from the map');
}

// ── with nothing captured, nothing is unsupported ────────────────────────────
{
  assert.deepEqual(conflicts([imaginedApi, realPlace]), [],
      'an empty map is a site nobody watched, not proof the endpoint is imaginary');
  console.log('  an empty API map accuses nobody');
}

// ── a dead end is corroborated by the map, not contradicted by it ────────────
{
  const gone = lesson({
    id: 'v1-metrics-gone', kind: 'dead-end',
    title: 'GET /api/v1/metrics no longer exists',
    gist: 'The v1 metrics endpoint was removed; it answers 404.',
  });
  assert.deepEqual(conflicts([gone], OBSERVED), [],
      'never seeing a route the store says is dead is agreement, and agreement is not a finding');
  console.log('  a dead end missing from the map is agreement, not conflict');
}

// ── prose with a slash in it is not a route ──────────────────────────────────
{
  const either = lesson({
    id: 'either-surface', kind: 'fact',
    title: 'The dashboard and/or the app works',
    gist: 'Either surface returns the same numbers.',
  });
  const neither = lesson({
    id: 'neither-surface', kind: 'fact',
    title: 'The dashboard and/or the app is gone',
    gist: 'Both were removed in the redesign.',
  });
  assert.deepEqual(conflicts([either, neither]), [],
      '`and/or` in a sentence is not the route `/or`, however hard the two lessons disagree');

  const needed = lesson({
    id: 'orders-first', kind: 'fact',
    title: 'You have to get /orders working before anything else',
    gist: 'It gates the rest of the flow.',
  });
  const undocumented = lesson({
    id: 'orders-undocumented', kind: 'fact',
    title: 'Nothing about how to get /orders working is written down',
    gist: 'The docs never mention it and it is gone from the sidebar.',
  });
  assert.deepEqual(conflicts([needed, undocumented]), [],
      'a lowercase "get" in a sentence does not vouch for a one-segment path');
  console.log('  slashes inside sentences do not become routes');
}

// ── a superseded lesson is meant to disagree with what replaced it ───────────
{
  const retired = { ...deadEnd, invalidated: { at: '2026-05-01', note: 'the endpoint came back' } };
  assert.deepEqual(conflicts([retired, fastPath]), [],
      'a lesson kept as the record of when a claim stopped holding is doing its job by disagreeing');
  console.log('  a superseded lesson is not reported against its replacement');
}

// ── candidate-finding changes nothing, which is the whole design ─────────────
{
  const corpus = [deadEnd, fastPath, invoicesWork, invoicesForbidden, searchByPost, searchByGet, imaginedApi, realPlace];
  const before = JSON.stringify(corpus);
  const findings = analyze(target(corpus, OBSERVED), []);
  assert.equal(JSON.stringify(corpus), before,
      'the model judges and the code proposes; analyze must not have touched a single entry');
  assert.equal(findings.contradictions.length, 4,
      `one of each shape and nothing extra, got ${JSON.stringify(findings.contradictions.map(i => i.path))}`);
  assert.deepEqual(kinds(findings.contradictions),
      ['dead-end-vs-fast-path', 'method-mismatch', 'opposite-advice', 'unobserved']);
  console.log('  a mixed corpus yields one of each shape and leaves the entries alone');
}

// ── what the agent actually reads ────────────────────────────────────────────
{
  const corpus = [deadEnd, fastPath, invoicesWork, invoicesForbidden, searchByPost, searchByGet, imaginedApi, realPlace];
  const rendered = renderCuration(DOMAIN, target(corpus, OBSERVED), analyze(target(corpus, OBSERVED), []));

  // Three, not four: a lesson nothing backs is not a conflict, because there is
  // no second claim to weigh it against. It gets a weaker section further down.
  assert.match(rendered, /## Contradictions \(3\)/, 'contradictions need a heading of their own');
  assert.equal(rendered.indexOf('## '), rendered.indexOf('## Contradictions'),
      'they go above every other section — this is the only one where doing nothing is worse than the tokens');
  assert.match(rendered, /\*\*not\*\* duplicates and must not be merged/,
      'a reader who treats these as duplicates buries the conflict instead of settling it');

  assert.ok(rendered.indexOf('## Contradictions') < rendered.indexOf('## Claimed but never seen'),
      'the weaker finding must not be read before the sharper one');
  assert.match(rendered, /only covers pages someone opened/,
      'the weaker finding has to admit why it is weaker, or it will be acted on as though it were proof');

  for (const label of ['dead end, and recommended as a fast path', 'Opposite advice', 'different verb', 'Claimed but never seen'])
    assert.ok(rendered.includes(label), `the reader has to be told which kind of conflict this is: ${label}`);
  for (const id of ['export-hangs', 'export-returns-json', 'invoices-forbidden', 'search-by-post', 'graphql-one-call'])
    assert.ok(rendered.includes(`\`${id}\``), `${id} has to be findable to be acted on`);

  console.log(`  the contradictions section leads the report, in ${rendered.length} chars`);
}

// ── a lesson already turned into a tool stops being recommended ─────────────
//
// The promote list is meant to say "this fast-path is worth becoming a tool".
// It deduped by asking whether a procedure's description contained the lesson
// title verbatim — a description an agent writes in its own words against a
// title written separately in other words, so it essentially never matched.
// Every fast-path stayed on the list forever, promoted ones included, and the
// section became a standing recommendation to redo work already done.
{
  const lesson: Lesson = {
    id: 'servers-metrics-fast-path', kind: 'fast-path',
    title: 'Read VPS metrics without the dashboard',
    gist: 'One call returns the series the chart draws.',
    body: '', trigger: '',
    snippet: 'await fetch(`/api/v1/servers/${id}/metrics?from=${from}`)',
    tags: [], created: '2026-07-01', updated: '2026-07-01', verified: '2026-07-01',
    confirmed: 2, failed: 0, used: 1,
  };
  const procedure: Procedure = {
    name: 'hostinger_servers_metrics', domain: 'panel.example.com',
    origin: 'https://panel.example.com',
    // Deliberately shares not one word with the lesson's title: this is how an
    // agent actually writes a description.
    description: 'Fetches CPU and memory samples for one virtual machine.',
    params: [], code: 'const path = "/api/v1/servers/:id/metrics".replace(":id", String(params.id));',
    mutating: false, expects: '', created: '2026-07-02', updated: '2026-07-02',
    lastRun: '2026-07-02', runs: 1, ok: 1, failed: 0, consecutiveFailures: 0,
    status: 'verified', findings: [],
  };

  const of = (procedures: Procedure[]) =>
    analyze({ domain: 'panel.example.com', entries: [lesson], procedures, endpoints: [] }, []);

  const before = of([]).promotable;
  assert.deepEqual(before.map(entry => entry.id), ['servers-metrics-fast-path'],
      'with no procedure for it, the fast-path is worth promoting');

  const after = of([procedure]).promotable;
  assert.deepEqual(after, [],
      'once the route is a tool, recommending it again is noise the reader learns to skip');
  console.log('  a fast-path already made into a tool drops off the promote list');
}

// ── a section with nothing in it is not a section ────────────────────────────
//
// `unobserved` shares the contradictions list and is deliberately not a
// conflict. The gate was the whole list while the heading and the body counted
// only the three conflict kinds, so a domain whose single finding was an
// unobserved claim printed `## Contradictions (0) — read these first` above a
// paragraph telling the reader to decide which of two claims is true, and then
// nothing at all.
{
  const claimed = lesson({
    id: 'stats-endpoint', kind: 'fact',
    title: 'The stats endpoint',
    gist: 'GET /api/v1/stats returns what the dashboard renders.',
    confirmed: 0,
  });
  const elsewhere: Endpoint[] = [{
    method: 'GET', path: '/api/v1/other', params: [], seen: 3,
    firstSeen: today, lastSeen: today, status: 200,
  }];
  const target: CurationTarget = {
    domain: DOMAIN, entries: [claimed], procedures: [], endpoints: elsewhere,
  };
  const findings = analyze(target, []);
  assert.deepEqual(findings.contradictions.map(item => item.kind), ['unobserved'],
      'the fixture has to produce the case: one lesson against silence, and no conflict');

  const rendered = renderCuration(DOMAIN, target, findings);
  assert.ok(!rendered.includes('## Contradictions'),
      'with no conflict there is no conflicts section, however the list is spelled');
  assert.ok(!rendered.includes('cannot both be true'),
      'and nothing tells the reader to weigh a pair that does not exist');
  assert.match(rendered, /## Claimed but never seen/,
      'the weaker finding still gets its own section');
  assert.ok(!rendered.includes('Weaker than the section above'),
      'phrased without pointing at a section that is not there');
  console.log('  an unobserved claim alone renders no contradictions section');
}

console.log('CONTRADICTIONS OK');
