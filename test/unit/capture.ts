/**
 * The failure this guards against is the one that was actually measured: a
 * 49-turn session across three sites finished, recorded nothing, and reported
 * that it had. Every lesson in the store depended on the agent choosing to
 * write it, and that choice is the least reliable part of the system.
 *
 * So this drives the Observer directly with the call traces a gateway would
 * see, and asserts that knowledge appears without anyone asking for it — and,
 * just as importantly, that noise does not.
 *
 * The detectors and the growth cap are here. What a recorded *step* contains —
 * selectors, refs, flows, the tree a reply only linked to — is steps.ts.
 *
 * No browser is involved: the observer's input is tool calls and their results,
 * which is exactly what can be written down here.
 */
import assert from 'node:assert/strict';

import { ApiMap } from '../../src/capture/apiMap.ts';
import { Observer } from '../../src/capture/observe.ts';
import { MemoryStore } from '../../src/memory/store.ts';
import { cleanup, tempMemoryDir } from '../harness.ts';

const memoryDir = await tempMemoryDir('capture');
const store = new MemoryStore(memoryDir);

const DOMAIN = 'panel.example.com';
/** Long enough to read as a payload rather than a bare return value. */
const JSON_BODY = JSON.stringify({ data: [{ id: 1, name: 'one' }, { id: 2, name: 'two' }] });

const evaluate = (code: string) => ({ function: code });

const titles = async (domain: string = DOMAIN): Promise<string[]> =>
  (await store.entries(domain)).map(entry => entry.title);

// ── an endpoint the agent proved works lands on the map, not in a lesson ────
//
// This used to write a `fast-path` lesson titled "GET /path returns data
// directly", which is what the API map is for — and the map already knew,
// because the agent's own fetch is a request the traffic miner watches go past.
// One call produced four records of one fact across three stores, each with its
// own spelling of the path to keep in step. What the lesson carried that the
// map did not is the code that worked, so that is what moved.
{
  const site = 'proven.example.com';
  const map = new ApiMap(memoryDir);
  // The map is built from what the site itself calls, so the route has to be
  // known before an agent's fetch can be recorded as proof of it.
  await map.learn(site, `  1. [GET] https://${site}/api/v1/servers?limit=50 => [200]`);

  const observer = new Observer(memoryDir, 'session-a');
  await observer.navigated(site);
  await observer.saw(
      'browser_evaluate',
      evaluate('async () => (await fetch("/api/v1/servers?limit=50&page=1")).json()'),
      JSON_BODY, false);

  assert.deepEqual(await titles(site), [],
      'the endpoint is the map\'s job; a lesson restating it is a second copy to keep in step');

  const [endpoint] = await map.forDomain(site);
  assert.ok(endpoint?.proven, 'but the proof must land somewhere — on the endpoint itself');
  assert.match(endpoint.proven.snippet, /fetch\("\/api\/v1\/servers/,
      'the code that worked is the part no template can guess');
  assert.ok(!endpoint.proven.snippet.includes('"name":"one"') &&
      !JSON.stringify(endpoint.proven).includes('"name":"one"'),
      'the response body must not be copied into memory');
  assert.match(endpoint.proven.returns, /JSON/, 'its shape is worth recording; its contents are not');
  console.log(`  proved on the map instead of duplicated: ${endpoint.method} ${endpoint.path}`);
}

// ── noise is not captured ────────────────────────────────────────────────────
{
  const before = (await titles()).length;
  const observer = new Observer(memoryDir, 'session-c');
  await observer.navigated(DOMAIN);
  // No request in it at all.
  await observer.saw('browser_evaluate', evaluate('() => document.title'), 'Some page title here', false);
  // A request that failed proves nothing about the endpoint.
  await observer.saw(
      'browser_evaluate',
      evaluate('async () => (await fetch("/api/v1/broken")).json()'),
      'Error: fetch failed', true);
  // Somebody else's API is not this site's fast path.
  await observer.saw(
      'browser_evaluate',
      evaluate('async () => (await fetch("https://api.stripe.com/v1/charges")).json()'),
      JSON_BODY, false);

  assert.equal((await titles()).length, before, 'none of those are knowledge about this site');
  console.log('  no lesson from a failed call, a bare expression, or a third-party host');
}

// ── the browser's echo of the code is not the response to it ────────────────
//
// The real reply shape, copied from a live call. A `browser_evaluate` that
// returned `null` still runs to 120 characters, because the browser prints the
// function source underneath the result — so the payload guard was padded by
// the very fetch call that made the detector want to fire, and the longer and
// more elaborate the snippet, the more certainly nothing became "returns data".
{
  const site = 'echo.example.com';
  const map = new ApiMap(memoryDir);
  await map.learn(site,
      `  1. [GET] https://${site}/api/v1/nothing => [200]\n` +
      `  2. [GET] https://${site}/api/v1/real => [200]`);

  const observer = new Observer(memoryDir, 'session-echo');
  await observer.navigated(site);
  const reply = (result: string, code: string): string =>
    `### Result\n${result}\n### Ran Playwright code\n\`\`\`js\nawait page.evaluate('${code}');\n\`\`\``;

  const nothing = 'async () => { await fetch("/api/v1/nothing?verbose=true&expand=all"); return null; }';
  await observer.saw('browser_evaluate', evaluate(nothing), reply('null', nothing), false);

  const proven = async (route: string) =>
    (await map.forDomain(site)).find(entry => entry.path === route)?.proven;
  assert.equal(await proven('/api/v1/nothing'), undefined,
      'a call that returned null proves nothing, however long the reply carrying it is');

  // And the reverse: a real payload in the same wrapper is still recorded.
  await observer.saw('browser_evaluate',
      evaluate('async () => (await fetch("/api/v1/real")).json()'),
      reply(JSON_BODY, '…'), false);
  const real = await proven('/api/v1/real');
  assert.ok(real, 'a genuine payload in the same wrapper still counts');
  // The size quoted has to be the payload's, not the reply's: the wrapper here
  // is over twice the length of what came back inside it.
  assert.match(real.returns, new RegExp(`~${JSON_BODY.length} chars`),
      'the shape is measured on the payload, not on the echo around it');
  assert.ok(!/page\.evaluate/.test(real.returns), 'the echo must not be described as the response');
  console.log('  a null result is not a payload, whatever the reply around it weighs');
}

// ── a repair waits for a second sighting, then lands with both halves ────────
{
  const before = await titles();

  /*
   * `flush` is part of the sequence, not tidying up afterwards. Deciding
   * whether an observation has earned a lesson means re-reading the log and
   * taking the domain lock, and that used to happen under `saw` — on the path
   * of every tool call, where a lock held by another agent could stall the
   * agent's next reply for fifteen seconds. The evidence is appended
   * synchronously; the promotion derived from it is drained at `flush`, which
   * the gateway already calls when the agent leaves a page and when the session
   * ends.
   */
  const hitTheWall = async (session: string): Promise<void> => {
    const observer = new Observer(memoryDir, session);
    await observer.navigated(DOMAIN);
    await observer.saw(
        'browser_click', { element: 'Save', ref: 'e12' },
        'Error: ref e12 resolved to 0 elements', true);
    await observer.saw('browser_click', { element: 'Save', ref: 'e47' }, 'Clicked Save', false);
    await observer.flush();
  };

  await hitTheWall('session-d');
  assert.deepEqual(await titles(), before, 'one failure-then-success can be a fumbled argument');

  await hitTheWall('session-e');
  const after = await titles();
  assert.equal(after.length, before.length + 1, 'a repair seen twice is a property of the site');

  const repair = (await store.entries(DOMAIN)).find(entry => entry.tags.includes('repair'));
  assert.ok(repair, 'the repair should be tagged');
  assert.match(repair.body, /e12/, 'the failing form is half the evidence');
  assert.match(repair.body, /e47/, 'the working form is the other half');
  console.log(`  repair promoted on the second sighting: ${repair.title}`);
}

// ── growth is bounded ────────────────────────────────────────────────────────
//
// Automatic capture is the only thing here that writes without a human in the
// loop, so this cap is what stands between a store and a landfill. Driven with
// form flows: endpoints go to the map now, which has a cap of its own, and a
// repair about the same tool and argument is deliberately one lesson however
// many times it recurs. A flow is keyed by the page it happens on, so thirty
// pages really are thirty things to write down — which is the case the cap is
// for.
{
  const other = 'busy.example.com';
  for (let n = 0; n < 30; n++) {
    // Twice, because a flow is only promoted once a second session repeats it.
    for (const session of [`busy-a-${n}`, `busy-b-${n}`]) {
      const observer = new Observer(memoryDir, session);
      await observer.navigated(other, `/forms/step-${n}`);
      const step = (tool: string, element: string) =>
        observer.saw(tool, { element, target: `role=textbox[name="${element}"]`, text: 'x' }, 'ok', false);
      await step('browser_type', `Name ${n}`);
      await step('browser_type', `Email ${n}`);
      await step('browser_click', `Submit ${n}`);
      await observer.flush();
    }
  }
  const found = await titles(other);
  assert.ok(found.length <= 20, `unbounded growth: ${found.length} lessons captured`);
  assert.ok(found.length >= 20, `the cap should be reached, not undershot: ${found.length}`);
  console.log(`  capped at ${found.length} automatic lessons per domain`);
}

await cleanup(memoryDir);
console.log('CAPTURE OK');
