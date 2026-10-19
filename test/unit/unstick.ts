/**
 * Recall on the error path.
 *
 * `matchSymptom` was written, tested and reachable only from `domain_unstick`,
 * which means it fired only when the agent remembered it existed. That is the
 * same shape as the capture failure that was actually measured — a 49-turn
 * session that recorded nothing and reported that it had — so the fix is the
 * same: the gateway looks at the error itself.
 *
 * Firing unbidden raises the stakes in the other direction. A wrong suggestion
 * on a failed call costs attention at the worst possible moment, and a bad
 * session has many failed calls. So the bar for the unbidden path is a trigger
 * found verbatim in the error text, and that is what these assert.
 */
import assert from 'node:assert/strict';

import { MemoryStore } from '../../src/memory/store.ts';
import { matchSymptom, symptomFrom, volunteeredFix } from '../../src/memory/recall.ts';
import { cleanup, tempMemoryDir } from '../harness.ts';

const memoryDir = await tempMemoryDir('unstick');
const store = new MemoryStore(memoryDir, 'session-seed');
const DOMAIN = 'panel.example.com';

await store.remember(DOMAIN, {
  kind: 'fix',
  title: 'The save button needs the address field blurred first',
  gist: 'Click outside the address field; validation runs on blur, not on input.',
  trigger: 'element is not enabled',
  body: 'Press Tab, then click Save.',
  tags: ['forms'],
});

await store.remember(DOMAIN, {
  kind: 'fast-path',
  title: 'Read the server list from the internal API',
  gist: 'GET /api/v1/servers returns what the table renders.',
  body: 'Session cookie is enough.',
  tags: ['servers', 'api'],
});

const applicable = await store.applicable(DOMAIN);

// ── the site's complaint is separated from our own additions ─────────────────
{
  const body = [
    'Error: element is not enabled',
    '',
    '### Open tabs',
    '- 0: (current) [Panel](https://panel.example.com/servers)',
  ].join('\n');
  assert.equal(symptomFrom(body), 'Error: element is not enabled');

  // A brief the gateway appended earlier in the same response is memory, not a
  // symptom. Matching against it is matching a domain against itself.
  const withBrief = `Error: element is not enabled\n\n---\n\n**Earlier agents have worked on ${DOMAIN}.**\n\nRead the server list from the internal API`;
  assert.equal(symptomFrom(withBrief), 'Error: element is not enabled');
  console.log('  the symptom excludes the tab list and any brief already appended');
}

// ── a trigger quoted verbatim in the error is offered ────────────────────────
{
  const symptom = symptomFrom('Error: element is not enabled\n\n### Open tabs\n- 0: (current) [x](https://panel.example.com/)');
  const best = volunteeredFix(applicable, symptom);
  assert.ok(best, 'a recorded trigger appearing verbatim in the error must be found');
  assert.match(best.title, /blurred first/);
  console.log(`  offered on a verbatim trigger: ${best.title}`);
}

// ── loose word overlap is not enough to interrupt ────────────────────────────
{
  // Shares "servers" and "api" with the fast-path lesson, which is exactly the
  // kind of incidental overlap a long error body produces. It scores well
  // enough for an agent that asked, and not well enough to volunteer.
  const noisy = 'Error: timeout after 30000ms waiting for /api/v1/servers to respond';
  assert.equal(volunteeredFix(applicable, noisy), undefined,
      'word overlap alone must not push a lesson at an agent that did not ask');
  assert.ok(matchSymptom(applicable, noisy).length > 0,
      'the same overlap should still answer domain_unstick, which was asked');
  console.log('  word overlap answers a question but does not interrupt');
}

// ── a fix that has been failing is not offered ───────────────────────────────
{
  const [fix] = applicable.filter(entry => entry.kind === 'fix');
  await store.report(DOMAIN, fix!.id, 'failed', 'did not help');
  await store.report(DOMAIN, fix!.id, 'failed', 'did not help');

  const symptom = 'Error: element is not enabled';
  const stale = await store.applicable(DOMAIN);
  assert.equal(volunteeredFix(stale, symptom), undefined,
      'two failures must take a fix off the unbidden path, where it costs attention unasked');
  assert.ok(matchSymptom(stale, symptom).length > 0,
      'but an agent that asks should still see it, with its warning');
  console.log('  a disputed fix stops being volunteered, and stays available if asked');
}

// ── a symptom too short to be quoted is not a verbatim match ─────────────────
//
// Containment is tested both ways, and the reverse direction had no floor:
// `trigger.includes('')` is true, so an empty symptom scored every lesson
// carrying a trigger at the full verbatim weight and `domain_unstick` answered
// "2 known fix(es) matching that symptom" for a symptom nobody described. Three
// letters did the same against any trigger containing them.
{
  const all = await store.applicable(DOMAIN);
  assert.deepEqual(matchSymptom(all, ''), [],
      'an empty symptom matches nothing; every trigger contains it');
  assert.deepEqual(matchSymptom(all, 'ena'), [],
      'and neither does a fragment too short to be a quotation, however well it is contained');

  const short = await store.remember(DOMAIN, {
    kind: 'fix',
    title: 'Short trigger',
    gist: 'A trigger nobody could recognise an error by.',
    trigger: 'enabled',
  });
  const withShort = await store.applicable(DOMAIN);
  const hits = matchSymptom(withShort, 'Error: element is not enabled');
  assert.ok(!hits.slice(0, 1).some(entry => entry.id === short.entry.id),
      'a seven-character trigger quoted inside an error must not outrank a real one');
  await store.forget(DOMAIN, short.entry.id);

  assert.ok(matchSymptom(withShort, 'Error: element is not enabled')
      .some(entry => entry.trigger === 'element is not enabled'),
      'while a trigger long enough to be a quotation still matches verbatim');
  console.log('  a symptom too short to be a quotation is not treated as one');
}

await cleanup(memoryDir);
console.log('UNSTICK OK');
