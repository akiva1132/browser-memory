/**
 * What a recorded step actually contains.
 *
 * The detectors in capture.ts answer whether a lesson appears at all. These
 * answer whether it is worth anything the next day: an address that survives a
 * restyle rather than a ref that expired with the snapshot, every step of a
 * flow and in order, no typed value ever reaching disk, and a page the agent
 * only read left out of the recording entirely.
 *
 * Same instrument as capture.ts — the Observer driven directly with the call
 * traces a gateway would see — and no browser.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { Observer } from '../../src/capture/observe.ts';
import { MemoryStore } from '../../src/memory/store.ts';
import { cleanup, stepsIn, tempMemoryDir } from '../harness.ts';

const memoryDir = await tempMemoryDir('steps');
const store = new MemoryStore(memoryDir);

const DOMAIN = 'panel.example.com';
const titles = async (domain: string = DOMAIN): Promise<string[]> =>
  (await store.entries(domain)).map(entry => entry.title);

// ── the selectors that worked, which is where the money was ──────────────────
//
// Replays the Gmail compose sequence from the measured runs. That phase cost
// 186 seconds and 36 calls, three runs in a row, because nothing about it was
// ever written down: the detectors looked at single calls, and the unit of UI
// work is a sequence.
{
  const GMAIL = 'mail.google.com';
  const compose = async (session: string): Promise<void> => {
    const observer = new Observer(memoryDir, session);
    await observer.navigated(GMAIL, '/mail/u/0');
    const step = (tool: string, element: string, target: string) =>
      observer.saw(tool, { element, target, text: 'you@example.com' }, 'ok', false);
    await step('browser_type', 'To field', 'div[data-compose="now"] input[role="combobox"]');
    await step('browser_type', 'Subject field', 'div[data-compose="now"] input[name="subjectbox"]');
    await step('browser_type', 'Message body', 'div[data-compose="now"] div[role="textbox"]');
    await step('browser_click', 'Attach files button', 'div[data-compose="now"] div[command="Files"]');
    await step('browser_click', 'Send button', 'div[data-compose="now"] div[role="button"][aria-label^="שליחה"]');
    // Leaving the page is what closes the flow.
    await observer.navigated(GMAIL, '/mail/u/0/#sent');
  };

  /*
   * Once is enough, and requiring twice was self-defeating.
   *
   * The old rule waited for a second sighting, which is right for a claim about
   * a site and wrong for a flow: every call in a flow ran, so its evidence is
   * already complete. And errands are performed once — so demanding a second
   * performance to record the first captured the flow exactly when it had
   * stopped being worth capturing. On the real log: three flows, each seen
   * once, none ever written.
   */
  await compose('gmail-first');
  const landmark = (await store.entries(GMAIL)).find(entry => entry.tags.includes('selectors'));
  assert.ok(landmark, 'a flow that ran end to end is already its own evidence');
  assert.equal(landmark.kind, 'landmark');
  assert.match(landmark.body, /data-compose="now"/, 'a selector the agent wrote deliberately is kept');
  assert.match(landmark.body, /aria-label\^="שליחה"/, 'including the one that took two tries to find');
  assert.match(landmark.body, /← css/,
      'but marked: it is tied to how the page is built, and fails differently from an anchor');
  assert.match(landmark.gist, /To field → Subject field/, 'and the order they go in');
  assert.ok(!landmark.body.includes('you@example.com'),
      'what was typed belonged to one errand and must not be stored');
  console.log(`  captured the flow on its first sighting: ${landmark.title}`);

  // ── every step, in order, with addresses that survive a restyle ────────────
  //
  // Read back out of the lesson body, which is now the only copy. It is also
  // the copy that was ever worth anything: the runnable one was offered to
  // twelve agents on a form it could have helped with and used by none.
  const steps = stepsIn(landmark.body);
  assert.equal(steps.length, 5, 'every step, in order');
  assert.deepEqual(steps.map(step => step.tool),
      ['browser_type', 'browser_type', 'browser_type', 'browser_click', 'browser_click']);
  // These are CSS, as the check above already established, and the parse has to
  // agree with it — a reader that quietly dropped the marking would report a
  // layout-tied selector as a durable one.
  assert.ok(steps.every(step => !step.anchored),
      'and each one is still marked as tied to the layout rather than to the element');
  assert.ok(steps.every(step => !step.target.includes('←')),
      'with the marking kept out of the address itself');

  // The value itself never reaches disk.
  assert.ok(!landmark.body.includes('you@example.com'),
      'the address in the To field is the errand; the To field is the site');
  console.log(`  and the steps are recoverable from it: ${steps.length}, each marked CSS`);
}

// ── the submit that navigates is part of the flow it completes ──────────────
//
// The commonest shape there is — fill, fill, submit — and it could not survive
// its own success. The gateway announced the new page before handing over the
// click, so the flow was flushed while it still had no click in it, failed the
// "was anything committed" test, and was discarded. The click then opened a
// fresh flow on the destination page, which never went anywhere either.
//
// Driven in the gateway's order rather than a convenient one, because the order
// is the bug.
{
  const site = 'checkout.example.com';
  const submit = async (session: string): Promise<void> => {
    const observer = new Observer(memoryDir, session);
    await observer.navigated(site, '/order');
    const step = (tool: string, element: string, target: string, landed: string) => async () => {
      // saw() first, then navigated() — a step belongs to the page it was made
      // on, not the one it led to.
      await observer.saw(tool, { element, target, text: 'x' }, 'ok', false);
      /*
       * `landed`, because that is what the gateway now passes for a page that
       * changed under a click, and this shape is the one that must survive it.
       *
       * A flow is allowed to carry on across a boundary its own commit caused,
       * so this no longer closes here — it spans to /receipt, finds nothing was
       * entered there, and trims back. The recording that comes out is the one
       * this case has always asserted, which is the whole point of checking it
       * with the real signal rather than the convenient one.
       */
      await observer.navigated(site, landed, 'landed');
    };
    await step('browser_type', 'Card number', 'role=textbox[name="Card number"]', '/order')();
    await step('browser_type', 'Expiry', 'role=textbox[name="Expiry"]', '/order')();
    // The click that submits: it lands on a different page.
    await step('browser_click', 'Pay now', 'role=button[name="Pay now"]', '/receipt')();
    await observer.flush();
  };

  await submit('submit-1');
  await submit('submit-2');
  const flow = (await store.entries(site)).find(entry => entry.tags.includes('selectors'));
  assert.ok(flow, 'a flow whose last step navigates is still a flow — it is the successful case');
  assert.match(flow.title, /\/order/, 'and it belongs to the page it was filled in on, not the receipt');
  assert.match(flow.body, /Pay now/, 'the submit is the step that makes the rest worth keeping');
  assert.match(flow.body, /Card number/);
  console.log(`  the submit that navigates is kept with its flow: ${flow.title}`);
}

// ── poking at a page is not a flow ───────────────────────────────────────────
{
  const site = 'browse.example.com';
  const poke = async (session: string): Promise<void> => {
    const observer = new Observer(memoryDir, session);
    await observer.navigated(site, '/catalog');
    for (const label of ['Next page', 'Sort by price', 'Close banner'])
      await observer.saw('browser_click', { element: label, target: `button[data-x="${label}"]` }, 'ok', false);
    await observer.flush();
  };
  await poke('poke-1');
  await poke('poke-2');
  assert.equal((await titles(site)).length, 0,
      'clicking around without filling anything in is exploration, not a flow');
  console.log('  clicking around is not recorded as a flow');
}

// ── a ref becomes the element it pointed at, or it is not stored at all ──────
//
// This is how the browser is actually driven: on the real audit log, 13 of 14
// recorded steps addressed their element by ref. A ref is a handle into one
// snapshot, so storing `f10e492` is worse than storing nothing — next session
// it resolves to whatever now occupies that slot and the agent clicks it. The
// snapshot the agent read it from went past the gateway, so the pair it names
// can be recovered at the moment the step works.
{
  const site = 'forms.example.com';
  const SNAPSHOT = `### Page state
- Page URL: https://forms.example.com/form
- Page Snapshot:
\`\`\`yaml
- dialog "New Message" [ref=f10e480]:
  - textbox "To recipients" [ref=f10e492]
  - textbox "Subject" [ref=f10e490]
  - button "Send ‪(Ctrl-Enter)‬" [active] [ref=f10e641]
  - generic [ref=f10e700]
\`\`\``;

  const byRef = async (session: string, snapshotFirst: boolean): Promise<void> => {
    const observer = new Observer(memoryDir, session);
    await observer.navigated(site, '/form');
    if (snapshotFirst)
      await observer.saw('browser_snapshot', {}, SNAPSHOT, false);
    await observer.saw('browser_type', { element: 'To', target: 'f10e492', text: 'x' }, 'ok', false);
    await observer.saw('browser_type', { element: 'Subject', target: 'f10e490', text: 'y' }, 'ok', false);
    await observer.saw('browser_click', { element: 'Send', target: 'f10e641' }, 'ok', false);
    await observer.flush();
  };

  await byRef('ref-blind-1', false);
  await byRef('ref-blind-2', false);
  assert.equal((await titles(site)).length, 0,
      'a ref nothing in this session explains is an id, and an id is not knowledge');

  await byRef('ref-seen-1', true);
  await byRef('ref-seen-2', true);
  const flow = (await store.entries(site)).find(entry => entry.tags.includes('selectors'));
  assert.ok(flow, 'the same three steps, with the snapshot to read them against, are a flow');
  assert.match(flow.body, /role=textbox\[name="To recipients"\]/, 'the pair is what survives a redesign');
  assert.match(flow.body, /role=button\[name="Send ‪\(Ctrl-Enter\)‬"\]/, 'including the punctuation');
  assert.ok(!/f10e\d+/.test(flow.body), 'and the ref itself must not reach the store');
  console.log('  a ref is resolved into role+name, or the step is dropped');
}

// ── the awkward lines a real snapshot contains ───────────────────────────────
//
// Roles and names are printed by the browser as `role "name"` followed by any
// attributes, with the ref last and the node's own text after a colon. Verified
// against a live chromium: `- combobox "To recipients"`, `- button "Send
// ‪(Ctrl-Enter)‬": Send`. Everything below is one of those shapes with the parts
// that break naive parsing — an attribute before the ref, a bracket inside a
// name, an escaped quote, indentation, and trailing text.
{
  const site = 'awkward.example.com';
  const SNAPSHOT = [
    '- dialog "Compose" [ref=e1]:',
    '  - combobox "To recipients" [ref=e2]',
    '  - textbox "Reply [draft]" [active] [ref=e3]',
    '  - button "Say \\"hi\\"" [ref=e4]: Say hi',
    '  - generic [ref=e5]: some text',
  ].join('\n');
  const fill = async (session: string): Promise<void> => {
    const observer = new Observer(memoryDir, session);
    await observer.navigated(site, '/compose');
    await observer.saw('browser_snapshot', {}, SNAPSHOT, false);
    await observer.saw('browser_type', { element: 'To', target: 'e2', text: 'x' }, 'ok', false);
    await observer.saw('browser_type', { element: 'Draft', target: 'e3', text: 'y' }, 'ok', false);
    await observer.saw('browser_click', { element: 'Say hi', target: 'e4' }, 'ok', false);
    await observer.flush();
  };
  await fill('awkward-1');
  await fill('awkward-2');
  const flow = (await store.entries(site)).find(entry => entry.tags.includes('selectors'));
  assert.ok(flow, 'these are ordinary snapshot lines and must parse');
  assert.match(flow.body, /role=combobox\[name="To recipients"\]/, 'indented, attribute-free');
  assert.match(flow.body, /role=textbox\[name="Reply \[draft\]"\]/, 'a bracket in the name, an attribute after it');
  assert.match(flow.body, /role=button\[name="Say \\"hi\\""\]/, 'an escaped quote survives the round trip');
  console.log('  the awkward snapshot lines parse into anchors');
}

// ── a role with no name is not an anchor ─────────────────────────────────────
//
// `role=generic` matches most of the page. An anchor that resolves to the wrong
// element is the failure this whole change exists to prevent, so a node the
// page never named is treated exactly like an unresolvable ref.
{
  const site = 'unnamed.example.com';
  const SNAPSHOT = '- generic [ref=e5]\n- generic [ref=e6]\n- generic [ref=e7]\n';
  const fill = async (session: string): Promise<void> => {
    const observer = new Observer(memoryDir, session);
    await observer.navigated(site, '/form');
    await observer.saw('browser_snapshot', {}, `\`\`\`yaml\n${SNAPSHOT}\`\`\``, false);
    await observer.saw('browser_type', { element: 'a', target: 'e5', text: 'x' }, 'ok', false);
    await observer.saw('browser_type', { element: 'b', target: 'e6', text: 'y' }, 'ok', false);
    await observer.saw('browser_click', { element: 'c', target: 'e7' }, 'ok', false);
    await observer.flush();
  };
  await fill('unnamed-1');
  await fill('unnamed-2');
  assert.equal((await titles(site)).length, 0, 'a role on its own points at too much to be an address');
  console.log('  an unnamed node does not become an anchor');
}

// ── the evidence log survives a torn write ───────────────────────────────────
{
  const site = 'torn.example.com';
  const log = path.join(memoryDir, 'observations.jsonl');
  await fs.appendFile(log, '{"at":"2026-01-01T00:00:00Z","domain":"x","dete', 'utf8');
  // A flow, because promotion is what reads the log back: it counts sightings
  // across sessions, so a log it cannot parse is a flow that never promotes.
  for (const session of ['torn-a', 'torn-b']) {
    const observer = new Observer(memoryDir, session);
    await observer.navigated(site, '/signup');
    const step = (tool: string, element: string) =>
      observer.saw(tool, { element, target: `role=textbox[name="${element}"]`, text: 'x' }, 'ok', false);
    await step('browser_type', 'Email');
    await step('browser_type', 'Password');
    await step('browser_click', 'Create account');
    await observer.flush();
  }
  assert.ok((await titles(site)).some(title => /signup/.test(title)),
      'a half-written line from a killed process must not discard the log');
  console.log('  a truncated log line does not stop capture');
}

// ── the tool that fills a whole form is one call and several steps ───────────
//
// `browser_fill_form` does the entire form in one go, which makes it the most
// natural way to perform exactly the interaction this feature exists to
// capture — and the recorder was watching only single-target tools, so it
// produced nothing at all. Both of its appearances in the real audit log, a
// registration and a login, recorded no flow.
//
// The arguments below are copied from one of them.
{
  const site = 'fillform.example.com';
  const observer = new Observer(memoryDir, 'fill-session');
  await observer.navigated(site, '/register');
  // The fields arrive as refs, so the tree they came from has to be read first
  // — exactly as for a direct call, and for the same reason: a ref is an id,
  // and an id is not knowledge.
  await observer.saw('browser_snapshot', {}, [
    '- textbox "Full name" [ref=e16]',
    '- textbox "Email" [ref=e19]',
    '- checkbox "Subscribe" [ref=e21]',
    '- button "Register" [ref=e30]',
  ].join('\n'), false);
  await observer.saw('browser_fill_form', {
    fields: [
      { target: 'e16', name: 'Full name', type: 'textbox', value: 'Dana Levi' },
      { target: 'e19', name: 'Email', type: 'textbox', value: 'you@example.com' },
      { target: 'e21', name: 'Subscribe', type: 'checkbox', value: 'true' },
    ],
  }, 'ok', false);
  await observer.saw('browser_click',
      { element: 'Register', target: 'role=button[name="Register"]' }, 'ok', false);
  await observer.flush();

  const [lesson] = (await store.entries(site)).filter(entry => entry.tags.includes('selectors'));
  assert.ok(lesson, 'one fill_form plus a submit is a flow');
  const unpacked = stepsIn(lesson.body);
  assert.equal(unpacked.length, 4, 'three fields and the click, not one opaque step');
  assert.deepEqual(unpacked.map(step => step.tool),
      ['browser_type', 'browser_type', 'browser_click', 'browser_click'],
      'each field gets the tool its own reported type is driven by — a checkbox is clicked');
  assert.ok(!lesson.body.includes('you@example.com'),
      'and nothing that was typed reaches disk, exactly as with a direct call');
  console.log(`  one fill_form became ${unpacked.length - 1} steps`);
}

// ── the tree the reply only linked to ────────────────────────────────────────
//
// Measured against the live browser: only `browser_snapshot` answers with an
// inline tree. `browser_navigate` and `browser_click` answer with
// `- [Snapshot](.playwright-mcp/page-….yml)` — 536 bytes, no `[ref=` in them at
// all. The agent opens that file itself, so it acts on refs this process never
// saw, and 80% of flow targets in the real audit log are refs.
//
// The consequence was total: a session that acted straight off a navigation
// recorded nothing. Not a trajectory, and not the role-and-name anchors that
// are the whole reason a landmark lesson survives a restyle. The two long-form
// runs did exactly that and produced an empty store.
{
  const site = 'linked.example.com';
  const LINKED = '### Page\n- Page URL: https://linked.example.com/apply\n' +
    '### Snapshot\n- [Snapshot](.playwright-mcp/page-2026-08-05T20-28-34-959Z.yml)';
  const TREE = [
    '- textbox "Full name" [ref=e8]',
    '- textbox "Email" [ref=e10]',
    '- button "Apply" [ref=e30]',
  ].join('\n');

  // Without the tree, the refs mean nothing and the flow is spoiled.
  const blind = new Observer(memoryDir, 'blind-session');
  await blind.navigated(site, '/apply');
  await blind.saw('browser_navigate', { url: `https://${site}/apply` }, LINKED, false);
  await blind.saw('browser_type', { element: 'Full name', target: 'e8', text: 'x' }, 'ok', false);
  await blind.saw('browser_type', { element: 'Email', target: 'e10', text: 'y' }, 'ok', false);
  await blind.saw('browser_click', { element: 'Apply', target: 'e30' }, 'ok', false);
  await blind.flush();
  assert.deepEqual(await titles(site), [],
      'refs nothing explains are ids, and this is what the gateway used to be left with');

  // Handed the tree the reply pointed at, the same calls resolve.
  const seeing = new Observer(memoryDir, 'seeing-session');
  await seeing.navigated(site, '/apply');
  await seeing.saw('browser_navigate', { url: `https://${site}/apply` }, LINKED, false, TREE);
  await seeing.saw('browser_type', { element: 'Full name', target: 'e8', text: 'x' }, 'ok', false);
  await seeing.saw('browser_type', { element: 'Email', target: 'e10', text: 'y' }, 'ok', false);
  await seeing.saw('browser_click', { element: 'Apply', target: 'e30' }, 'ok', false);
  await seeing.flush();
  const [resolved] = (await store.entries(site)).filter(entry => entry.tags.includes('selectors'));
  assert.ok(resolved, 'reading the file the reply named is the difference between everything and nothing');
  assert.deepEqual(stepsIn(resolved.body).map(step => step.target), [
    'role=textbox[name="Full name"]',
    'role=textbox[name="Email"]',
    'role=button[name="Apply"]',
  ], 'and the refs become the durable pairs, not ids');
  console.log('  a tree the reply only linked to is read, or the whole session records nothing');
}

// ── a step that cannot be recorded spoils the flow, rather than shortening it ─
//
// Measured on the real audit log: `browser_file_upload` carries `paths` and no
// target at all — twelve times — and `browser_press_key` carries `{key}` three
// times. Both were dropped quietly, leaving the rest of the flow in place.
//
// A sequence with a hole in it is not a shorter sequence, it is a different
// one, and this one gets replayed: "click Attach → choose the file → click
// Send" recorded as "click Attach → click Send" replays as opening a file
// picker and then submitting the form behind it with nothing attached.
{
  const site = 'attach.example.com';
  const observer = new Observer(memoryDir, 'attach-session');
  await observer.navigated(site, '/compose');
  const step = (tool: string, element: string, args: Record<string, unknown> = {}) =>
    observer.saw(tool, { element, target: `role=textbox[name="${element}"]`, ...args }, 'ok', false);
  await step('browser_type', 'To', { text: 'a@b.com' });
  await step('browser_type', 'Subject', { text: 'hi' });
  // The real shape: no target, because an upload applies to whatever picker is open.
  await observer.saw('browser_file_upload', { paths: ['/tmp/report.pdf'] }, 'ok', false);
  await observer.saw('browser_click',
      { element: 'Send', target: 'role=button[name="Send"]' }, 'ok', false);
  await observer.flush();

  assert.deepEqual(await titles(site), [],
      'the upload could not be written down, so no lesson claims those are the steps');

  // The same three steps without the unrecordable one are still recorded, so
  // this is a spoil rather than a blanket refusal.
  const clean = new Observer(memoryDir, 'clean-session');
  await clean.navigated(site, '/contact');
  const ok = (tool: string, element: string, args: Record<string, unknown> = {}) =>
    clean.saw(tool, { element, target: `role=textbox[name="${element}"]`, ...args }, 'ok', false);
  await ok('browser_type', 'To', { text: 'a@b.com' });
  await ok('browser_type', 'Subject', { text: 'hi' });
  await clean.saw('browser_click', { element: 'Send', target: 'role=button[name="Send"]' }, 'ok', false);
  await clean.flush();
  assert.equal((await store.entries(site)).filter(entry => entry.tags.includes('selectors')).length, 1,
      'a flow with nothing missing still records');
  console.log('  an unrecordable step discards the flow instead of leaving a hole in it');
}

// ── the agent's call does not wait for the bookkeeping ───────────────────────
//
// The measured bug: promotion re-read the whole log and then took the domain
// lock, all under `await observer.saw(...)` — which the gateway calls on every
// single tool call. `withLock` waits up to fifteen seconds. So a second agent
// holding the lock for the same site could stall this one's next reply for
// fifteen seconds with the browser sitting idle, for a lesson nobody was
// waiting to read.
//
// Held here by writing the lock file directly rather than by running a second
// agent: what is being asserted is a duration, and a real competitor would make
// it depend on how fast that competitor happened to be.
{
  const site = 'contended.example.com';
  const lockPath = path.join(memoryDir, `${site}.lock`);
  await fs.writeFile(lockPath, `someone-else ${new Date().toISOString()}`, 'utf8');

  const observer = new Observer(memoryDir, 'blocked-session');
  await observer.navigated(site);
  const started = Date.now();
  await observer.saw(
      'browser_click', { element: 'Save', ref: 'e12' },
      'Error: ref e12 resolved to 0 elements', true);
  await observer.saw('browser_click', { element: 'Save', ref: 'e47' }, 'Clicked Save', false);
  const waited = Date.now() - started;

  // Generous on purpose. The point is the difference between "returned" and
  // "sat behind a lock for fifteen seconds", not a millisecond budget.
  assert.ok(waited < 2000,
      `saw() waited ${waited}ms behind a lock held by someone else; the agent's next call pays that`);

  // And the evidence is on disk regardless, because that part stayed
  // synchronous — the log is what a later session recounts from.
  const log = await fs.readFile(path.join(memoryDir, 'observations.jsonl'), 'utf8');
  assert.ok(log.includes(site), 'the observation itself is appended on the call, not deferred');
  await fs.rm(lockPath, { force: true });
  console.log(`  a lock held by another agent costs the call ${waited}ms, not 15s`);
}

await cleanup(memoryDir);
console.log('STEPS OK');
