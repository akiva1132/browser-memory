/**
 * Every body here came out of a live browser, driven at a page built to fail in
 * each of these ways. That matters more than usual: this whole module keys on
 * the exact wording of somebody else's error messages, and a diagnosis written
 * against imagined text would pass a test written against the same imagined
 * text and never fire once against the real thing.
 *
 * What it has to get right is the distinction the browser buries: a click that
 * failed because the target was wrong, and a click that failed although the
 * target was right. They read alike — both open with the word Timeout — and
 * they call for opposite next moves.
 */
import assert from 'node:assert/strict';

import { explainFailure, readFailure } from '../../src/browser/diagnose.ts';
import { FAILURES } from '../fixtures/failures.ts';

// ── an element that is there but cannot be clicked ───────────────────────────
{
  const failure = readFailure(FAILURES.notVisible);
  assert.equal(failure?.cause, 'hidden');
  assert.ok(failure.timedOut, 'this is the shape that costs five seconds');
  assert.match(failure.element ?? '', /input id="r"/, 'what the locator hit is half the answer');

  const said = explainFailure(FAILURES.notVisible)!;
  assert.match(said, /not visible/);
  assert.match(said, /label/, 'the fix for a styled radio is its label, and saying so is the point');
  assert.match(said, /Retrying this target will time out again/,
      'the measured failure was a second five-second attempt at the same element');
  console.log(`  hidden element: ${said.split('\n').filter(Boolean)[0]?.slice(0, 72)}…`);
}

// ── an element that is fine, with something on top of it ─────────────────────
//
// The hard case. The call log says "element is visible, enabled and stable"
// three times over, so anything reading for trouble finds none — the operative
// line is the one naming what intercepted the click.
{
  const failure = readFailure(FAILURES.intercepted);
  assert.equal(failure?.cause, 'covered', 'visible-and-stable is not the same as clickable');
  assert.equal(failure.blocker, '<div class="cover"></div>', 'naming the blocker is the whole answer');

  const said = explainFailure(FAILURES.intercepted)!;
  assert.match(said, /div class="cover"/, 'the agent has to be told what to close');
  assert.match(said, /keep timing out until then/);
  console.log('  covered element: names the thing sitting on top');
}

// ── the two that fail fast, and need no excuse for being slow ────────────────
{
  const stale = readFailure(FAILURES.staleRef);
  assert.equal(stale?.cause, 'stale-ref');
  assert.equal(stale.timedOut, false, 'a missing ref is rejected in milliseconds, not seconds');
  assert.match(explainFailure(FAILURES.staleRef)!, /role and accessible name/,
      'the durable form is what stops this recurring');
  assert.ok(!/full action timeout/.test(explainFailure(FAILURES.staleRef)!),
      'and it must not be blamed for a wait it never made');

  const missing = readFailure(FAILURES.noMatch);
  assert.equal(missing?.cause, 'no-match');
  assert.match(explainFailure(FAILURES.noMatch)!, /browser_find/, 'the cheap way to locate something');
  console.log('  a stale ref and an empty match are told apart, and neither is called slow');
}

// ── silence on anything it cannot actually explain ───────────────────────────
{
  for (const body of [
    '### Error\nError: net::ERR_CONNECTION_REFUSED at https://example.com/',
    '### Error\nError: Navigation timeout of 60000 ms exceeded',
    '### Result\nDone.',
    '',
  ])
    assert.equal(explainFailure(body), undefined,
        'padding an error with a guess is worse than leaving the browser to speak for itself');
  console.log('  no diagnosis invented for a failure it does not recognise');
}

console.log('DIAGNOSE OK');
