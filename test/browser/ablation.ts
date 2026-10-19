/**
 * Each memory layer, measured against its own absence.
 *
 * `BROWSER_MEMORY_WITHOUT` used to know two names and neither was a memory
 * layer, so a warm run that beat a cold one beat it by *something* and no
 * number of runs could say which. That is the gap these switches close, and a
 * switch that silently does nothing closes it the wrong way: an arm meant to
 * run without lessons runs with all of them, agrees closely with the control,
 * and the conclusion written down is that lessons are worth nothing. Nothing
 * about that failure looks wrong at any point, which is why it is worth a test.
 *
 * The cut has to be complete. Removing a layer from the brief while leaving the
 * tool that serves it is not an arm without that layer — it is an arm where the
 * agent pays one extra turn and gets it anyway, which measures as the feature
 * being *worth* something.
 *
 * Needs the browser stack up: the brief is appended to a navigation, so
 * checking what it omits means navigating.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { serveFixtures } from '../../eval/fixtures/serve.ts';
import { GATEWAY, Harness, cleanup, tempMemoryDir } from '../harness.ts';

const PORT = 8981;
const PAGE = `http://127.0.0.1:${PORT}/registration.html`;

const memoryDir = await tempMemoryDir('ablation');
const server = await serveFixtures(PORT);

/** Starts a gateway with one arm's switches set, and returns its tool list and brief. */
async function arm(without: string): Promise<{ tools: string[]; brief: string }> {
  const harness = await Harness.start(memoryDir, without ? { BROWSER_MEMORY_WITHOUT: without } : {});
  try {
    return { tools: await harness.toolNames(), brief: await harness.text('browser_navigate', { url: PAGE }) };
  } finally {
    await harness.close();
  }
}

try {
  // ── something to withhold ─────────────────────────────────────────────────
  //
  // Written through the tool an agent would use, rather than into the store
  // file directly: a switch tested against a shape nobody produces is a switch
  // tested against nothing.
  const first = await Harness.start(memoryDir);
  try {
    await first.call('domain_remember', {
      url: PAGE,
      kind: 'landmark',
      title: 'The paid ticket radio is visually hidden',
      gist: 'Click the label, not the input — the input has zero size and the click never lands.',
      body: 'The styled radio hides its real `input`, so a click on it times out on actionability. ' +
        'Click the `label` that wraps it instead.',
      trigger: 'you need to choose a ticket type here',
    });
  } finally {
    await first.close();
  }

  // ── the control ────────────────────────────────────────────────────────────
  const control = await arm('');
  assert.ok(control.tools.includes('domain_brief'));
  assert.match(control.brief, /Earlier agents have worked on/, 'the lesson reaches the brief');
  assert.match(control.brief, /visually hidden/, 'in full, body and all');
  console.log('  with everything on, the brief carries the lesson');

  // ── without lessons ────────────────────────────────────────────────────────
  const noLessons = await arm('lessons');
  assert.ok(!noLessons.tools.includes('domain_brief'), 'the tool that serves them goes too');
  assert.ok(!noLessons.tools.includes('domain_open'));
  assert.doesNotMatch(noLessons.brief, /Earlier agents have worked on/);
  assert.doesNotMatch(noLessons.brief, /visually hidden/);
  console.log('  without lessons: neither the brief nor the tools can reach them');

  // ── without the API map ────────────────────────────────────────────────────
  const noApi = await arm('api');
  assert.ok(!noApi.tools.includes('domain_interface'));
  assert.ok(!noApi.tools.includes('procedure_draft'), 'drafting reads the map, so it goes too');
  assert.ok(noApi.tools.includes('domain_brief'), 'and lessons are untouched');
  console.log('  without the API map: the tools that read it are withdrawn');

  /*
   * ── the brief arrives finished, and says so by not asking again ───────────
   *
   * The default here changed on 51 runs of evidence: staged disclosure cost
   * `domain_brief` → `domain_open` → `domain_report`, three calls per domain
   * before any work began, and removing the round trip took 17.3 → 11.3 turns
   * on one scenario and 16.8 → 10.0 on another while serving *more* content.
   *
   * What has to hold is the absence of a sentence. The invitation is the round
   * trip — an agent told "Open the ones you need" opens them — so a future
   * edit that reinstates a helpful-sounding "pull the full text with
   * domain_open" would undo the whole result without changing a number here.
   */
  assert.match(control.brief, /^## /m, 'lessons arrive already open');
  assert.doesNotMatch(control.brief, /Open the ones you need/,
      'and nothing in the brief asks for a second call');
  assert.doesNotMatch(control.brief, /domain_curate/,
      'including the curation nudge, which fires on exactly the domains with most to read');

  /*
   * ── the brief says a lesson may be wrong, and that fixing it is allowed ────
   *
   * Measured before it was written: a false lesson marked reliable was refused
   * by four runs out of four, and left in the store by three of them — each
   * giving a version of "this is shared state you did not ask me to modify".
   * The behaviour was careful; the permission was missing.
   *
   * What has to hold is that the sentence names the tool and the case. An edit
   * that softened it to a general "keep the store tidy" would leave the same
   * gap while looking like the same feature.
   */
  assert.match(control.brief, /correcting it is part of the job/,
      'the brief has to grant the permission, not just serve the knowledge');
  assert.match(control.brief, /domain_report[\s\S]{0,120}outcome: "failed"/,
      'and name the call, since the agents that declined had the tool all along');
  const noCorrection = await arm('correction');
  assert.doesNotMatch(noCorrection.brief, /correcting it is part of the job/);
  assert.match(noCorrection.brief, /Earlier agents have worked on/,
      'and nothing else goes with it — this switch is one sentence');
  console.log('  the brief grants permission to correct a lesson, and the grant is ablatable');

  const staged = await arm('inline');
  assert.match(staged.brief, /Open the ones you need/,
      'the old form stays reachable, because the comparison has to stay runnable');
  assert.doesNotMatch(staged.brief.split('**Places on')[0] ?? '', /^## /m,
      'and it is genuinely the old form: titles, not bodies');
  console.log('  the brief arrives finished by default, and the staged form is still runnable');

  // ── several at once, and a name that is not one ────────────────────────────
  const bare = await arm('lessons,api,places');
  assert.ok(!bare.tools.includes('domain_brief') && !bare.tools.includes('domain_interface'));
  assert.doesNotMatch(bare.brief, /Earlier agents have worked on/);

  /*
   * A misspelt switch has to be loud.
   *
   * Ignoring it produces an arm that quietly ran *with* the feature it was
   * meant to run without — and the report of that arm looks exactly like a
   * report of a feature that does nothing.
   */
  const exit = await new Promise<number>(resolve => {
    const child = spawn('node', [GATEWAY], {
      env: { ...process.env, BROWSER_MEMORY_DIR: memoryDir, BROWSER_MEMORY_WITHOUT: 'lesson' },
      stdio: 'ignore',
    });
    child.on('exit', code => resolve(code ?? -1));
  });
  assert.equal(exit, 2, 'an unknown feature name must stop the run, not be ignored');
  console.log('  several arms compose, and a misspelt one refuses to start');
} finally {
  await new Promise(resolve => server.close(resolve));
  await cleanup(memoryDir);
}

console.log('ABLATION OK');
