/**
 * The diagnosis, through the real gateway and a real browser.
 *
 * The unit test proves the reading; this proves an agent actually receives it,
 * on the path where it matters. The page below is built to reproduce what the
 * audit log recorded: a styled radio whose real input is hidden, and a button
 * under an overlay. Between them they accounted for four five-second timeouts
 * in one session, each answered by retrying the same element and then sleeping.
 */
import assert from 'node:assert/strict';

import { Harness, textOf, cleanup, tempMemoryDir } from '../harness.ts';

const PAGE = `<!doctype html><title>Failing form</title>
<style>.hidden{position:absolute;opacity:0;width:0;height:0}
.cover{position:fixed;inset:0;background:rgba(0,0,0,.3)}</style>
<label for=r>Paid event</label><input class=hidden type=radio id=r name=k>
<button id=b>Continue</button><div class=cover></div>`;

const memoryDir = await tempMemoryDir('failures');
const harness = await Harness.start(memoryDir);
await harness.call('browser_navigate', { url: `data:text/html,${encodeURIComponent(PAGE)}` });

// ── the click that cannot land ───────────────────────────────────────────────
{
  const started = Date.now();
  const result = await harness.call('browser_click', { element: 'Paid event radio', target: 'role=radio' });
  const said = textOf(result);
  assert.ok(result.isError, 'clicking a hidden input fails');
  assert.match(said, /Why it failed/, 'and the agent must be told why, not just that');
  assert.match(said, /not visible/);
  assert.match(said, /Retrying this target will time out again/,
      'the measured mistake was trying the same element a second time, for another five seconds');
  console.log(`  hidden radio: failed in ${Date.now() - started}ms, and said what to do instead`);
}

// ── the click blocked by something on top of it ──────────────────────────────
{
  const said = textOf(await harness.call('browser_click',
      { element: 'Continue', target: 'role=button[name="Continue"]' }));
  assert.match(said, /Why it failed/);
  assert.match(said, /div class="cover"/, 'naming the overlay is the whole answer');
  assert.ok(!/not visible/.test(said.split('Why it failed')[1] ?? ''),
      'a covered element reports as visible and stable, and must not be diagnosed as hidden');
  console.log('  covered button: names the element to dismiss first');
}

// ── a working call is never decorated with a failure ─────────────────────────
{
  const said = textOf(await harness.call('browser_navigate', { url: 'https://example.com' }));
  assert.ok(!/Why it failed/.test(said), 'nothing that succeeded should carry a diagnosis');
  console.log('  a call that worked carries no diagnosis');
}

await harness.close();
await cleanup(memoryDir);
console.log('FAILURES OK');
