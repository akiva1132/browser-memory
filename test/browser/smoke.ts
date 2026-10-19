/**
 * End-to-end against a live gateway: proves the agent sees one server carrying
 * both the browser tools and the memory tools, that a lesson survives a
 * write/recall round trip, and that trust degrades on reported failure.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { Harness, cleanup, tempMemoryDir } from '../harness.ts';

const memoryDir = await tempMemoryDir('smoke');
const harness = await Harness.start(memoryDir);

const tools = await harness.tools();
const names = tools.map(tool => tool.name);
console.log(`tools advertised: ${tools.length}`);
assert.ok(names.includes('domain_brief'), 'memory tools must be advertised');
assert.ok(names.includes('browser_navigate'), 'upstream browser tools must be proxied');

const remember = tools.find(tool => tool.name === 'domain_remember');
assert.ok(remember?.inputSchema.properties?.['kind'], 'zod schemas must reach the agent as JSON Schema');

assert.match(await harness.text('domain_brief', { url: 'https://shop.example.com/cart' }),
    /No memory for shop\.example\.com yet/);

await harness.call('domain_remember', {
  url: 'https://example.com',
  kind: 'fast-path',
  title: 'Read orders straight from the internal API',
  gist: 'GET /api/v2/orders returns what the orders table renders; skips five clicks.',
  body: 'Session cookie is enough. Paginate with ?page=N.',
  snippet: "await fetch('/api/v2/orders').then(r => r.json())",
  tags: ['orders', 'api'],
});
await harness.call('domain_remember', {
  url: 'https://shop.example.com',
  kind: 'fix',
  title: 'Checkout button stays disabled until address blur',
  gist: 'Blur the address field; the button enables on blur, not on input.',
  trigger: 'checkout button is disabled',
  body: 'The form validates on blur. Click elsewhere, then the button enables.',
});

const brief = await harness.text('domain_brief', {
  url: 'https://shop.example.com/cart',
  goal: 'place an order',
});
console.log('\n--- brief ---\n' + brief);
assert.ok(brief.includes('from example.com'), 'apex lessons must be inherited by subdomains');
assert.ok(brief.includes('read-orders-straight-from-the-internal-api'), 'ids must be listed');

const unstick = await harness.text('domain_unstick', {
  url: 'https://shop.example.com/checkout',
  symptom: 'the checkout button is disabled and nothing happens when I click it',
});
console.log('\n--- unstick ---\n' + unstick);
assert.ok(unstick.includes('Blur the address field'), 'symptom must match the recorded trigger');

const opened = await harness.text('domain_open', {
  url: 'https://shop.example.com',
  ids: ['read-orders-straight-from-the-internal-api'],
});
assert.ok(opened.includes("fetch('/api/v2/orders')"), 'snippet must come back on open');

const failing = {
  url: 'https://example.com',
  id: 'read-orders-straight-from-the-internal-api',
  outcome: 'failed',
};
await harness.call('domain_report', { ...failing, note: 'returns 404 now' });
const second = await harness.text('domain_report', { ...failing, note: 'still 404' });
console.log('\n--- after two failures ---\n' + second);
assert.match(second, /DISPUTED/, 'two failures must demote a lesson');

console.log('\nstored files:', await fs.readdir(memoryDir));
await harness.close();
await cleanup(memoryDir);
console.log('\nSMOKE OK');
