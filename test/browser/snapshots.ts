/**
 * The collapse, through a real gateway and a real browser.
 *
 * The unit test proves the rule; this proves the wiring, which is where the
 * mistake would actually be. Two things have to hold at once and only the live
 * path can show it: the agent stops receiving trees it already has, and every
 * part of the gateway that reads the tree still gets the real one — the ref
 * resolution behind captured flows depends on it.
 */
import assert from 'node:assert/strict';

import { Harness, textOf, cleanup, tempMemoryDir } from '../harness.ts';

const PAGE = 'https://news.ycombinator.com';

const memoryDir = await tempMemoryDir('snapshots');
const harness = await Harness.start(memoryDir);

await harness.call('browser_navigate', { url: PAGE });

const first = textOf(await harness.call('browser_snapshot'));
assert.match(first, /```yaml/, 'the first snapshot of a page is the whole tree');
const nodes = (first.match(/\[ref=/g) ?? []).length;
assert.ok(nodes > 50, `a real page should have more than 50 refs, got ${nodes}`);

// ── the same page again, with nothing done in between ────────────────────────
const second = textOf(await harness.call('browser_snapshot'));
assert.match(second, /Unchanged/, 'an identical tree must not be sent twice');
assert.ok(second.length < first.length / 4,
    `the point is the size: ${first.length} → ${second.length}`);
// The header is still live — a tab may have opened while the tree stood still.
assert.match(second, /### Open tabs/);
assert.match(second, /Page URL/);
assert.match(second, new RegExp(`same ${nodes} elements`),
    'the agent has to be told what it is not being sent, counted in things it can address');
console.log(`  repeat snapshot of ${nodes} refs: ${(first.length / 1024).toFixed(1)}KB → ` +
  `${(second.length / 1024).toFixed(1)}KB (${Math.round(100 - 100 * second.length / first.length)}% less)`);

// ── a page that changed is sent in full ──────────────────────────────────────
await harness.call('browser_navigate', { url: 'https://example.com' });
const elsewhere = textOf(await harness.call('browser_snapshot'));
assert.match(elsewhere, /```yaml/, 'a different page is a different tree');
assert.ok(!/Unchanged/.test(elsewhere), 'and must never be reported as unchanged');
console.log('  a different page is answered in full');

// ── going back to the first page: the tree is out of reach, so it is sent ────
//
// The collapse is only honest while the agent still holds the earlier reply.
// Here the tree from the top of this file is two navigations behind, so what
// matters is that the gateway sends something the agent can act on.
await harness.call('browser_navigate', { url: PAGE });
const again = textOf(await harness.call('browser_snapshot'));
assert.ok(/```yaml/.test(again) || /Unchanged/.test(again));
if (/Unchanged/.test(again))
  assert.match(again, /calls ago|previous call/, 'if it collapses it must say where to look');
console.log('  returning to a page answers with a tree or a reachable pointer');

await harness.close();
await cleanup(memoryDir);
console.log('SNAPSHOTS OK');
