/**
 * Drafting a procedure from an endpoint the site was already seen calling.
 *
 * `procedure_save` describes itself as the highest-leverage thing an agent can
 * leave behind, and across three measured runs it was called zero times. What
 * it asks for is a name, an origin, a parameter list and a body of JavaScript,
 * composed from nothing, at the end of a task, under a review gate. Nearly all
 * of that is already in the API map.
 *
 * The generated code has to be right, because nobody reads generated code
 * carefully. These check the two things that actually break: a path with more
 * than one placeholder, and query names that are not valid identifiers.
 */
import assert from 'node:assert/strict';

import { draftCode, draftFor, renderDraft, suggestName, suggestParams } from '../../src/capture/draft.ts';
import type { Endpoint } from '../../src/capture/apiMap.ts';
import { PROCEDURE_NAME } from '../../src/procedures/store.ts';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as
  new (...args: string[]) => unknown;

const endpoint = (over: Partial<Endpoint>): Endpoint => ({
  method: 'GET', path: '/api/v1/servers', params: [], seen: 3,
  firstSeen: '2026-08-01', lastSeen: '2026-08-02', status: 200, ...over,
});

// ── the name comes from the site and the path, not from the versioning ───────
{
  assert.equal(
      suggestName('hpanel.hostinger.com', endpoint({ path: '/api/v1/servers/:id/metrics' })),
      'hostinger_servers_metrics');
  // Not `dash_*`: the first label names the dashboard, not the site, and the
  // next dashboard is also called dash.
  assert.equal(
      suggestName('dash.cloudflare.com', endpoint({ method: 'POST', path: '/api/v4/zones' })),
      'cloudflare_post_zones');
  assert.equal(suggestName('shop.example.co.uk', endpoint({ path: '/api/orders' })), 'example_orders');
  console.log('  named from the site and the path');
}

// ── every placeholder in the path becomes a parameter, and gets filled ────────
{
  const twoIds = endpoint({ path: '/api/v1/accounts/:id/servers/:id/metrics' });
  const params = suggestParams(twoIds) ?? [];
  assert.deepEqual(params.map(param => param.name), ['id1', 'id2']);
  assert.ok(params.every(param => param.required), 'a path placeholder is not optional');

  const code = draftCode(twoIds);
  assert.ok(code.includes('params.id1') && code.includes('params.id2'),
      `both placeholders must be filled:\n${code}`);
  // The bug this guards: String.replace with a string needle replaces only the
  // first occurrence, so a naive one-shot substitution leaves the second `:id`
  // literal in the URL and the procedure 404s on its first run.
  assert.equal((code.match(/\.replace\(':id'/g) ?? []).length, 2,
      'one replace per placeholder, or the second stays literal');
  console.log('  a path with two placeholders fills both');
}

// ── a query name that is not an identifier still produces valid code ─────────
{
  // Real, from hPanel: `?statuses[]&types[]`.
  const awkward = endpoint({ path: '/api/billing/api/v1/order', params: ['statuses[]', 'types[]', 'per_page'] });
  const params = suggestParams(awkward) ?? [];
  assert.deepEqual(params.map(param => param.name), ['statuses', 'types', 'per_page'],
      'the parameter an agent passes must be a usable name');

  const code = draftCode(awkward);
  assert.ok(code.includes('query.set("statuses[]", String(params.statuses))'),
      `the wire name is kept and the identifier is cleaned:\n${code}`);
  // Compiled, never called, and the input is this file's own fixture routed
  // through our generator — a syntax check, which is the only way to assert
  // that code we emit is code at all. Async because buildEvaluateFunction
  // wraps procedure bodies in `async () => { … }`, and a draft that fetches
  // without awaiting would be a draft that returns a Promise.
  assert.doesNotThrow(() => new AsyncFunction('params', code), 'generated code must parse');
  console.log('  awkward query names produce valid code and keep the wire name');
}

// ── a request that changes something is declared, gated, and not empty ──────
//
// A drafted POST used to be both unsafe and inert. `mutating` was never set, so
// it saved as read-only and ran with no confirmation gate — on exactly the
// requests a generated draft is most likely to have wrong. And nothing declared
// a `body` parameter, so the code sent `JSON.stringify(params.body ?? {})`,
// which is `{}` on every single call: it changed something, always with an
// empty payload.
{
  assert.ok(!draftCode(endpoint({})).includes('method:'), 'a GET needs no method or body');

  const post = endpoint({ method: 'POST' });
  const code = draftCode(post);
  assert.match(code, /method: "POST"/);
  assert.match(code, /body: params\.body/, 'the body has to come from the caller, not from nowhere');
  assert.ok(!/params\.body \?\? \{\}/.test(code), 'a default of {} is an empty request dressed as a working one');

  const drafted = draftFor('example.com', post);
  assert.equal(drafted.mutating, true, 'anything that is not a GET is gated until a human says otherwise');
  const body = drafted.params?.find(param => param.name === 'body');
  assert.ok(body, 'the body must be a declared parameter or the code above reads undefined');
  assert.equal(body.required, true);

  const rendered = renderDraft('example.com', drafted);
  assert.match(rendered, /mutating: true/, 'and the save template has to carry it, or the gate is lost');

  const read = draftFor('example.com', endpoint({ method: 'GET' }));
  assert.equal(read.mutating, false);
  assert.ok(!/mutating/.test(renderDraft('example.com', read)), 'a GET should not be gated for nothing');
  console.log('  a non-GET draft is gated, declares its body, and sends it');
}

// ── every generated name is one procedure_save will actually accept ─────────
//
// The draft path exists to lower the barrier to saving. It cut names at 60
// against a limit of 49, so a deep path produced a snippet rejected the moment
// anyone copied it — failing precisely on the endpoints deep enough to be worth
// saving. Checked against the store's own rule rather than a copy of it.
{
  const paths = [
    '/api/v1/organizations/:id/projects/:id/environments/:id/deployments/:id/logs/download/archive',
    '/api/v2/a',
    '/',
    '/api/v1/////',
    '/api/graphql',
  ];
  for (const path of paths) {
    for (const method of ['GET', 'DELETE']) {
      const name = suggestName('some-very-long-subdomain.example.co.uk', endpoint({ path, method }));
      assert.ok(PROCEDURE_NAME.test(name),
          `"${name}" (${name.length} chars) must satisfy the rule procedure_save enforces`);
    }
  }
  console.log('  generated names satisfy the rule the store enforces, at any path depth');
}

// ── what the agent is left to do is stated, not hidden ───────────────────────
{
  const draft = draftFor('hpanel.hostinger.com', endpoint({ path: '/api/v1/servers/:id/metrics', params: ['from'] }));
  const rendered = renderDraft('hpanel.hostinger.com', draft);
  assert.match(draft.code, /TODO: return the part that answers/,
      'which field is the answer is the one thing only the agent knows');
  assert.match(rendered, /Run it first/, 'a draft is not a verified procedure');
  assert.match(rendered, /seen 3x, last returning 200/, 'the evidence for the draft belongs in it');
  assert.match(rendered, /procedure_save\(\{/, 'the next step should be copy-pasteable');
  console.log('  the draft states what is left to do and what it is based on');
}

console.log('DRAFT OK');
