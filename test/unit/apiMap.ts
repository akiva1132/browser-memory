/**
 * The fixture below is real `browser_network_requests` output, copied from one
 * navigation to hPanel. That matters: the previous version of this system was
 * built against an API that turned out not to exist, so the parser is tested
 * against traffic the browser actually produced rather than against a shape
 * that seemed likely.
 *
 * What it has to get right is separating a site's interface from everything
 * else on the wire — analytics, error reporting, bot checks — and collapsing
 * the same endpoint called with different ids into one entry.
 */
import assert from 'node:assert/strict';

import { ApiMap, drift, parseRequest, renderApiMap } from '../../src/capture/apiMap.ts';
import type { Endpoint } from '../../src/capture/apiMap.ts';
import { cleanup, tempMemoryDir } from '../harness.ts';

const DOMAIN = 'hpanel.hostinger.com';

const LISTING = `### Result
303. [POST] https://hpanel.hostinger.com/cdn-cgi/challenge-platform/h/g/jsd/oneshot/f70cb377/0.138 => [200]
309. [POST] https://o215831.ingest.sentry.io/api/1355666/envelope/?sentry_version=7&sentry_key=e643 => [200]
311. [GET] https://sr-client-cfg.amplitude.com/config/82eb9b6dc70a2922?config_group=browser => [200]
313. [GET] https://experiment-api.hostinger.com/sdk/v2/vardata?v=0 => [200]
314. [GET] https://hpanel.hostinger.com/api/billing/api/v1/customer/subscriptions/nudges?gaid=GA1.1.98 => [200]
315. [GET] https://hpanel.hostinger.com/api/billing/api/v1/order?statuses%5B%5D=completed&types%5B%5D=trial_order&gaid=GA1.1.98 => [200]
316. [GET] https://hpanel.hostinger.com/api/billing/api/v1/order?statuses%5B%5D=completed&types%5B%5D=trial_order&gaid=GA1.1.98 => [200]
317. [GET] https://hpanel.hostinger.com/api/billing/api/v1/payment/get-payment-methods?gaid=GA1.1.98 => [200]
318. [GET] https://hpanel.hostinger.com/api/auth/api/external/v1/profile?gaid=GA1.1.98 => [200]
350. [POST] https://rvlclick.hostinger.com/z?key=publishable_key_live_EXAMPLE0000000 => [204]
352. [GET] https://hpanel.hostinger.com/api/resources/api/v2/resources?state%5B%5D=created&state%5B%5D=active&gaid=GA1.1.98 => [200]
353. [GET] https://hpanel.hostinger.com/api/billing/api/v1/customer/invoices?status=payment_due&gaid=GA1.1.98 => [200]
360. [GET] https://hpanel.hostinger.com/api/vps/v1/virtual-machines/1234567/metrics?from=1785600000 => [200]
361. [GET] https://hpanel.hostinger.com/api/vps/v1/virtual-machines/7654321/metrics?from=1785600000 => [200]
370. [GET] https://hpanel.hostinger.com/api/billing/api/v1/customer/invoices/98765/download => [403]
380. [GET] https://hpanel.hostinger.com/dashboard/websites => [200]
`;

const memoryDir = await tempMemoryDir('apimap');
const map = new ApiMap(memoryDir);

const added = await map.learn(DOMAIN, LISTING);
const endpoints = await map.forDomain(DOMAIN);
const paths = endpoints.map(entry => `${entry.method} ${entry.path}`);

// ── the site's own interface, and only that ──────────────────────────────────
assert.ok(paths.includes('GET /api/billing/api/v1/customer/invoices'), 'billing invoices should be learned');
assert.ok(paths.includes('GET /api/auth/api/external/v1/profile'), 'the profile endpoint should be learned');
assert.ok(paths.includes('GET /api/resources/api/v2/resources'), 'the resources endpoint should be learned');

for (const noise of ['sentry.io', 'amplitude', 'rvlclick', 'cdn-cgi']) {
  assert.ok(!JSON.stringify(endpoints).includes(noise), `${noise} is telemetry, not an interface`);
}

/*
 * Analytics served from the site's own host, which host filtering cannot see.
 * This is real: the Tailscale console proxies Rudderstack through
 * `/api/rudderstack-proxy/`, and it was filed as part of the interface — on
 * the list an agent reads to choose what to call.
 */
{
  const PROXIED = 'proxied.example.com';
  await map.learn(PROXIED, [
    '  1. [GET] https://proxied.example.com/api/rudderstack-proxy/sourceConfig?writeKey=abc => [200]',
    '  2. [POST] https://proxied.example.com/api/rudderstack-proxy/v1/page => [200]',
    '  3. [POST] https://proxied.example.com/api/v1/analytics/event => [200]',
    '  4. [GET] https://proxied.example.com/api/v1/devices => [200]',
  ].join('\n'));
  assert.deepEqual((await map.forDomain(PROXIED)).map(entry => entry.path), ['/api/v1/devices'],
      'telemetry on the site\'s own host is still telemetry');
  console.log('  analytics proxied through the site\'s own origin is not its interface');
}
assert.ok(!paths.includes('GET /dashboard/websites'), 'an HTML route is a page, not an endpoint');

/*
 * A page whose own URL contains `/api/` — which `LOOKS_LIKE_API` cannot tell
 * from an endpoint, because on the wire they are the same line. Documentation
 * sites are full of these: platform.claude.com serves `/docs/en/api/overview`
 * as HTML, and the first harvest of it filed seven of its own navigations as
 * endpoints. Whoever navigated is the only one who knows, so they say so.
 */
{
  const DOCS = 'docs.example.com';
  const listing = [
    '  1. [GET] https://docs.example.com/docs/en/api/overview => [200]',
    '  2. [GET] https://docs.example.com/docs/en/api/messages/create => [200]',
    '  3. [GET] https://docs.example.com/api/v1/search?q=x => [200]',
  ].join('\n');
  await map.learn(DOCS, listing, ['/docs/en/api/overview', '/docs/en/api/messages/create']);
  assert.deepEqual((await map.forDomain(DOCS)).map(entry => entry.path), ['/api/v1/search'],
      'the pages that were navigated to are pages; the endpoint beside them is not');
  console.log('  a page whose URL contains /api/ is excluded by whoever navigated to it');

  /*
   * The harder half of the same problem, and the one that actually produced the
   * seven bad entries: a router prefetching *other* pages. Nobody navigated to
   * these, so the exclusion above cannot see them — but the framework leaves a
   * marker in the query string, which makes it a fact rather than a guess.
   *
   * The lines below are real, copied from platform.claude.com.
   */
  const PREFETCH = [
    '  260. [GET] https://docs.example.com/docs/en/api/overview?_rsc=ni-mGmoYGBmdk0j_ => [200]',
    '  204. [GET] https://docs.example.com/docs/en/api/messages/create?_rsc=lKsgZKg3arbMify_ => [200]',
    '  195. [GET] https://docs.example.com/docs/en/api/skills/create-skill?_rsc=lKsgZKg3arbMify_ => [307]',
    '  300. [GET] https://docs.example.com/_next/data/build123/en/api/models.json => [200]',
    '  301. [GET] https://docs.example.com/api/v1/feedback?rating=5 => [200]',
  ].join('\n');
  const PRE = 'prefetch.example.com';
  await map.learn(PRE, PREFETCH.replaceAll('docs.example.com', PRE));
  assert.deepEqual((await map.forDomain(PRE)).map(entry => entry.path), ['/api/v1/feedback'],
      'a prefetched page payload is the next page, not an interface');
  console.log('  router prefetches are excluded by their own marker, with no navigation needed');
}
assert.ok(!JSON.stringify(endpoints).includes('/download'), 'a 403 is not a working endpoint');
console.log(`  learned ${added} endpoints, rejected the telemetry`);

// ── a sibling host counts as part of the same site ───────────────────────────
assert.ok(paths.includes('GET /sdk/v2/vardata'),
    'experiment-api.hostinger.com shares the apex domain and is part of this site');

// ── ids collapse; parameter names survive ────────────────────────────────────
const metrics = endpoints.find(entry => /virtual-machines/.test(entry.path));
assert.ok(metrics, 'the metrics endpoint should be present');
assert.equal(metrics.path, '/api/vps/v1/virtual-machines/:id/metrics', 'two VPS ids are one endpoint');
assert.deepEqual(metrics.params, ['from'], 'the parameter name is the reusable part');

const order = endpoints.find(entry => entry.path === '/api/billing/api/v1/order');
assert.deepEqual(order?.params, ['statuses[]', 'types[]'], 'array parameters keep their shape');
assert.ok(!JSON.stringify(endpoints).includes('gaid'), 'a per-browser id is not a parameter of the endpoint');
console.log('  ids collapse, parameter names survive, tracking ids are dropped');

// ── the same page visited twice sharpens the map instead of duplicating it ───
{
  const before = (await map.forDomain(DOMAIN)).length;
  const newlyAdded = await map.learn(DOMAIN, LISTING);
  const after = await map.forDomain(DOMAIN);
  assert.equal(newlyAdded, 0, 'a second visit reveals nothing new');
  assert.equal(after.length, before, 'and must not duplicate what is already known');
  assert.ok(after.every(entry => entry.seen >= 2), 'but it is more evidence for what is there');
  console.log('  a repeat visit confirms rather than duplicates');
}

// ── what the agent actually reads ────────────────────────────────────────────
{
  const rendered = renderApiMap(DOMAIN, await map.forDomain(DOMAIN));
  assert.match(rendered, /GET \/api\/billing\/api\/v1\/customer\/invoices/);
  assert.match(rendered, /takes from/, 'parameters have to reach the agent to be useful');
  assert.match(rendered, /session cookies already in the browser/);
  console.log(`  brief renders in ${rendered.length} chars`);
}

// ── a route that stops answering is recorded, not just overwritten ───────────
//
// The expensive failure this prevents: an agent reads a fast-path lesson, calls
// the endpoint it names, and works out from scratch that the site moved. The
// traffic already knew — mining runs on every navigation regardless — and the
// only thing missing was writing down that the answer changed.
{
  const SITE = 'shifting.example.com';
  await map.learn(SITE, '  1. [GET] https://shifting.example.com/api/v1/things => [200]');
  assert.deepEqual((await map.drift(SITE)).broken, [], 'a working route is not drift');

  await map.learn(SITE, '  1. [GET] https://shifting.example.com/api/v1/things => [404]');
  const { broken } = await map.drift(SITE);
  assert.equal(broken.length, 1, 'a route that used to answer and now 404s is the signal');
  assert.equal(broken[0]!.path, '/api/v1/things');
  assert.ok(broken[0]!.brokeAt, 'when it stopped is the part that answers "since when"');
  assert.match(renderApiMap(SITE, await map.forDomain(SITE)), /⚠ answering 404 since/,
      'it has to be on the line the agent is choosing from, not in a footnote');

  // A site that fixes itself should stop being reported, or the warning becomes
  // background noise that gets skipped when it is finally true.
  await map.learn(SITE, '  1. [GET] https://shifting.example.com/api/v1/things => [200]');
  assert.deepEqual((await map.drift(SITE)).broken, [], 'a route that recovers is no longer drift');
  console.log('  a route that stops answering is flagged, and unflagged when it recovers');

  /*
   * Being rate-limited is not the route being gone, and the difference is not
   * academic: the harvest crawl tripped Hostinger's limit on its first real
   * run and stamped six working endpoints `⚠ answering 429`. A warning that
   * fires on healthy routes is worse than none, because it teaches agents to
   * scroll past the one that is true.
   */
  for (const transient of [429, 401, 403, 500, 502, 503, 504, 408]) {
    await map.learn(SITE, `  1. [GET] https://shifting.example.com/api/v1/things => [${transient}]`);
    assert.deepEqual((await map.drift(SITE)).broken, [],
        `${transient} says something about the moment, not about the route`);
    assert.equal((await map.forDomain(SITE))[0]?.status, 200,
        `${transient} must not overwrite the last status the route was known to answer with`);
  }

  // But gone is still gone, and a route that 404s after a bad minute is caught.
  await map.learn(SITE, '  1. [GET] https://shifting.example.com/api/v1/things => [410]');
  assert.equal((await map.drift(SITE)).broken.length, 1, '410 is the site saying the route is gone');
  await map.learn(SITE, '  1. [GET] https://shifting.example.com/api/v1/things => [200]');
  console.log('  a rate limit is not a redesign; 404/405/410 still are');
}

// ── silence is not the same as breakage ──────────────────────────────────────
{
  const seen = (path: string, days: number, times: number): Endpoint => ({
    method: 'GET', path, params: [], seen: times,
    firstSeen: '2026-01-01',
    lastSeen: new Date(Date.parse('2026-08-01T00:00:00Z') - days * 86400000).toISOString().slice(0, 10),
    status: 200,
  });
  // Judged against the map's own last update, so a store nobody has touched for
  // a year does not report its entire contents as vanished.
  const { quiet } = drift(
      [seen('/api/v1/current', 1, 9), seen('/api/v1/gone', 60, 9), seen('/api/v1/once', 60, 1)],
      '2026-08-01');
  assert.deepEqual(quiet.map(endpoint => endpoint.path), ['/api/v1/gone'],
      'long silence on a route the site leaned on is worth noticing; one sighting never was');
  console.log('  a route that goes quiet is reported separately from one that breaks');
}

// ── an endpoint someone actually called carries the proof, not a lesson ─────
//
// One `fetch` used to produce four records of one fact across three stores: an
// endpoint here, a fast-path lesson beside it, a promotion suggestion, a draft
// candidate — each with its own spelling of the path to keep in step. The map
// already knew the route existed, because the agent's own request is traffic
// the miner watches go past. What the lesson carried that the map did not is
// the code that worked, so that is what moved.
{
  const SITE = 'proof.example.com';
  await map.learn(SITE, '  1. [GET] https://proof.example.com/api/v1/servers?limit=50 => [200]');

  const before = (await map.forDomain(SITE))[0];
  assert.ok(before && !before.proven, 'seeing the page call it is not the same as calling it');

  await map.prove(SITE, 'GET', '/api/v1/servers',
      'await (await fetch("/api/v1/servers?limit=50", {credentials:"include"})).json()',
      'a JSON payload (~2100 chars, contains arrays)');

  const [endpoint] = await map.forDomain(SITE);
  assert.match(endpoint?.proven?.snippet ?? '', /credentials:"include"/,
      'the working code is the part a template cannot guess');
  assert.match(endpoint?.proven?.returns ?? '', /contains arrays/);
  assert.ok(!JSON.stringify(endpoint).includes('"data"'),
      'the shape is recorded, never the contents');
  const rendered = renderApiMap(SITE, await map.forDomain(SITE));
  assert.match(rendered, /✓ called directly/,
      'an agent choosing what to call should see which one is proved');
  // Announcing that working code exists and making the reader fetch it is the
  // round trip this brief was built to remove. `procedure_draft` was the only
  // way to it, and was called zero times across 594 recorded tool calls while
  // four separate sessions rewrote the same fetch by hand.
  assert.match(rendered, /credentials:"include"/,
      'the code that worked is served where the endpoint is, not one call away');

  // A route mining has not reached yet is added, not discarded. Mining runs on
  // a timer and on leaving a domain, so an endpoint an agent has just fetched
  // is routinely absent at the moment it is proved — on the real store, four of
  // seven were. Declining there does not keep the map honest, it throws away
  // the better evidence of the two.
  await map.prove(SITE, 'GET', '/api/v2/reports', 'await fetch("/api/v2/reports")', 'a JSON object');
  const added = (await map.forDomain(SITE)).find(entry => entry.path === '/api/v2/reports');
  assert.ok(added?.proven, 'an endpoint an agent proved works belongs in the map even if mining missed it');

  // But the interface test still applies, so fetching a page is not an endpoint.
  await map.prove(SITE, 'GET', '/dashboard/websites', 'await fetch("/dashboard/websites")', 'html');
  assert.ok(!(await map.forDomain(SITE)).some(entry => entry.path === '/dashboard/websites'),
      'an ordinary page fetched from script is still a page');
  console.log('  proof lands on the endpoint, and may create one the traffic missed');
}

// ── the brief's limit must not be what hides the proved route ───────────────
//
// Endpoints are ordered by how often the site's own pages call them, and the
// limit is there to drop one-off calls. Proof is the opposite kind of evidence
// and arrives one deliberate fetch at a time, so the two rules worked against
// each other: on the real store four of five proven endpoints fell below the
// cut and never reached a brief. `/api/v4/zones` sat at rank 18 of 37 while
// four sessions rewrote it by hand.
{
  const busy = (path: string, seen: number): Endpoint => ({
    method: 'GET', path, params: [], seen, firstSeen: '2026-08-01', lastSeen: '2026-08-06', status: 200,
  });
  const rare: Endpoint = {
    ...busy('/api/v1/zones', 1),
    proven: { snippet: 'await fetch("/api/v1/zones")', returns: 'a JSON object', at: '2026-08-06' },
  };
  const rendered = renderApiMap(
      'cut.example.com', [busy('/billing', 30), busy('/servers', 20), busy('/tickets', 10), rare], 2);

  assert.match(rendered, /\/api\/v1\/zones/, 'the one route known to work is not what a limit drops');
  assert.match(rendered, /await fetch\("\/api\/v1\/zones"\)/, 'and it arrives with the call that worked');
  assert.ok(rendered.indexOf('/api/v1/zones') < rendered.indexOf('/billing'),
      'nor is it listed below routes that have only ever been watched');
  // The cap still governs everything that is merely observed: proof buys a
  // route its place in the list, it does not widen the list.
  assert.ok(!rendered.includes('/tickets'), 'the limit still applies to the routes nobody has proved');
  assert.match(rendered, /…and 2 more/, 'and what it dropped is still counted honestly');
  console.log('  a proven endpoint outranks the limit, and says so with its code');
}

// ── a listing with nothing in it is not an error ─────────────────────────────
assert.equal(await map.learn('empty.example.com', '### Result\nNote: 6 static requests not shown.\n'), 0);
assert.deepEqual(await map.forDomain('empty.example.com'), []);
assert.equal(parseRequest('total nonsense', DOMAIN), undefined);

await cleanup(memoryDir);
console.log('API MAP OK');
