/**
 * The behaviour that makes this worth having is that it releases on its own.
 * A hand-off that requires the user to solve the CAPTCHA *and then* come back
 * to a chat window and type "done" is worse than no hand-off — people stop
 * using it and go back to doing the whole task themselves.
 *
 * So the cases below are mostly about when it returns and when it refuses to:
 * on a page change with no reply at all, never just because the message was
 * delivered, and — the one that silently ruined it before 20/10 — never by
 * waiting out a timeout when the message could not be sent at all.
 *
 * Driven with a fake browser and a fake notifier, because the interesting
 * states (a send that fails, a user who never acts) are precisely the ones that
 * are hard to stage against a real one.
 */
import assert from 'node:assert/strict';

import { askUserTools } from '../../src/browser/askUser.ts';
import type { AskDelivery, AskDeps, ToolResult } from '../../src/browser/askUser.ts';
import type { HandoffView, HqHandoffs } from '../../src/gateway/hq.ts';

type Fake = {
  deps: AskDeps;
  calls: { name: string; args: Record<string, unknown> }[];
  page: { url: string; text: string };
};

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });

const sent = async (): Promise<AskDelivery> => ({ ok: true });

/** Delivered is the normal case; the user then acts on the page and never replies. */
function fake(options: { ask?: AskDeps['ask'] } = {}): Fake {
  const page = { url: 'https://site.example/login', text: 'Verify you are human' };
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    page,
    calls,
    deps: {
      call: async (name, args) => {
        calls.push({ name, args });
        if (name === 'browser_tabs' && args['action'] === 'list')
          return text('0: https://other.example — Other\n1: https://site.example/login — Login (current)');
        if (name === 'browser_evaluate') {
          const marker = /includes\("((?:[^"\\]|\\.)*)"\)/.exec(String(args['function']))?.[1] ?? '';
          const present = Boolean(marker) && page.text.includes(marker);
          // Quoted and escaped, the way a returned string actually comes back.
          return text(`### Result\n\"probe:${page.url} marker:${present}\"`);
        }
        return text('ok');
      },
      ask: options.ask ?? sent,
    },
  };
}

const tool = (f: Fake) => askUserTools(f.deps)[0]!;
const polls = (f: Fake) => f.calls.filter(call => call.name === 'browser_evaluate').length;

// ── it raises the agent's own tab, not whichever one is on screen ────────────
{
  const f = fake();
  setTimeout(() => { f.page.url = 'https://site.example/done'; }, 1600);
  await tool(f).handle({ need: 'captcha', what: 'Tick the box', timeoutSeconds: 10 });
  const select = f.calls.find(call => call.name === 'browser_tabs' && call.args['action'] === 'select');
  assert.ok(select, 'the tab must be raised before the user is asked about it');
  assert.equal(select.args['index'], 1, 'and it must be the index the listing marked as ours');
  console.log('  raises our own tab, by the index the listing marks current');
}

// ── the point of the whole thing: released by the page, with no reply ────────
{
  const f = fake();
  const started = Date.now();
  setTimeout(() => { f.page.text = 'Welcome back'; }, 1800);
  const result = await tool(f).handle({
    need: 'captcha', what: 'Tick the reCAPTCHA', untilTextGone: 'Verify you are human', timeoutSeconds: 20,
  });
  assert.match(result, /has done it/, 'solving it on the page is the answer');
  assert.match(result, /page changed while waiting/);
  assert.match(result, /fresh snapshot/, 'the agent must be told its view is stale');
  assert.ok(Date.now() - started < 8000, 'it should notice within a poll or two, not wait out the timeout');
  console.log(`  released by the page alone in ${((Date.now() - started) / 1000).toFixed(1)}s, no reply needed`);
}

// ── a URL change counts when no marker text was given ────────────────────────
{
  const f = fake();
  setTimeout(() => { f.page.url = 'https://site.example/dashboard'; }, 1600);
  const result = await tool(f).handle({ need: 'login', what: 'Sign in', timeoutSeconds: 20 });
  assert.match(result, /has done it/);
  assert.match(result, /site\.example\/dashboard/, 'the agent needs to know where it ended up');
  console.log('  a URL change releases it when nothing else was named');
}

// ── exactly one message per ask ──────────────────────────────────────────────
{
  const titles: string[] = [];
  const f = fake({ ask: async title => { titles.push(title); return { ok: true }; } });
  setTimeout(() => { f.page.url = 'https://site.example/done'; }, 1600);
  await tool(f).handle({ need: 'captcha', what: 'Tick the box', timeoutSeconds: 10 });
  assert.deepEqual(titles, ['תורך: Tick the box'], 'exactly one message per ask, in Hebrew');
  console.log('  one message per ask');
}

// ── delivered is not done: the page still has to change ──────────────────────
{
  const f = fake();
  const started = Date.now();
  setTimeout(() => { f.page.text = 'Welcome back'; }, 2000);
  const result = await tool(f).handle({
    need: 'captcha', what: 'Tick the box', untilTextGone: 'Verify you are human', timeoutSeconds: 20,
  });
  assert.ok(Date.now() - started > 1500, 'a delivered message must not be read as the user having done it');
  assert.match(result, /has done it/, 'the page watcher is what releases it');
  console.log('  a delivered message still waits for the page');
}

// ── a failed send is an error now, not a silent wait ─────────────────────────
//
// The measured failure: the notifier broke, the failure went to the trace only,
// and the agent sat out the whole timeout for a user who had been told nothing.
{
  const f = fake({ ask: async () => ({ ok: false, reason: 'telegram send via telegram-send failed: 401' }) });
  const started = Date.now();
  await assert.rejects(
      () => tool(f).handle({
        need: 'captcha', what: 'Tick the box', untilTextGone: 'Verify you are human', timeoutSeconds: 60,
      }),
      (error: Error) => {
        assert.match(error.message, /NOT notified/);
        assert.match(error.message, /401/, 'the reason must reach the agent, not only the trace');
        assert.match(error.message, /Tick the box/, 'and so must what the user is needed for');
        return true;
      });
  const took = Date.now() - started;
  assert.ok(took < 3000, `it must fail at once, not wait out the timeout — took ${took}ms`);
  const at = polls(f);
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.equal(polls(f), at, 'and it must not leave a watcher polling behind it');
  console.log(`  a failed send returns a visible error in ${took}ms`);
}

// ── a notifier that throws is the same failure, not a crash or a hang ────────
{
  const f = fake({ ask: async () => { throw new Error('spawn telegram-send ENOENT'); } });
  await assert.rejects(
      () => tool(f).handle({ need: 'login', what: 'Sign in', timeoutSeconds: 60 }),
      /NOT notified.*ENOENT/);
  console.log('  a throwing notifier is reported the same way');
}

// ── nothing to wait for is answered now, not in a minute ─────────────────────
//
// The marker was already true before anyone was asked, so the page watcher can
// never see the change, and no reply comes back through the chat channel. Only
// the expiry timer would be left.
{
  const f = fake();
  const started = Date.now();
  const result = await tool(f).handle({
    need: 'login', what: 'Sign in with your Google account',
    untilTextAppears: 'Verify you are human', timeoutSeconds: 60,
  });
  const waited = Date.now() - started;
  assert.ok(waited < 5_000, `must not sit out the timeout with nothing to wait for — waited ${waited}ms`);
  assert.match(result, /no way to tell when it is finished/);
  assert.match(result, /untilTextAppears/, 'the useless marker is the thing to name');
  assert.ok(!/user has done it/.test(result), 'and it must not claim success: nothing here is evidence');
  console.log(`  no signal either way: answered in ${waited}ms instead of 60s`);
}

// ── giving up says so, without failing the task ──────────────────────────────
{
  const f = fake();
  const result = await tool(f).handle({
    need: 'captcha', what: 'Tick the box', untilTextGone: 'Verify you are human', timeoutSeconds: 5,
  });
  assert.match(result, /probably not been done yet/);
  assert.match(result, /Do not retry the step yourself/, 'a timeout must not send it back to guessing');
  console.log('  a timeout reports honestly and forbids retrying the step');
}

// ── a condition that is already true is not evidence of anything ─────────────
{
  const f = fake();
  const result = await tool(f).handle({
    need: 'consent', what: 'Accept the cookie banner', untilTextGone: 'text that was never there',
    timeoutSeconds: 5,
  });
  assert.doesNotMatch(result, /user has done it/,
      'text that was already absent would otherwise report success in zero seconds');
  assert.match(result, /no way to tell when it is finished/);
  console.log('  an already-satisfied condition does not fake instant success');
}

// ── it stops interrogating the page once it is released ──────────────────────
{
  const f = fake();
  setTimeout(() => { f.page.text = 'Welcome back'; }, 1600);
  await tool(f).handle({
    need: 'captcha', what: 'Tick the box', untilTextGone: 'Verify you are human', timeoutSeconds: 30,
  });
  const at = f.calls.filter(call => call.name === 'browser_evaluate').length;
  await new Promise(resolve => setTimeout(resolve, 4000));
  const after = f.calls.filter(call => call.name === 'browser_evaluate').length;
  assert.equal(after, at,
      'polling must stop on release; otherwise it keeps hitting a live browser for the whole timeout');
  console.log('  stops polling the moment it is released');
}

// ── it refuses to ask a question it has not been given ───────────────────────
await assert.rejects(
    () => tool(fake()).handle({ need: 'other', what: '  ' }),
    /must say what the user should do/);

// ── the company hq: a phone link to our own tab, and "done" that comes straight back ──
type FakeHq = HqHandoffs & { created: Record<string, unknown>[]; ended: string[]; finish(state: HandoffView['state']): void };
function fakeHq(options: { busyFrom?: string } = {}): FakeHq {
  const view: HandoffView = {
    id: 'h-1', state: 'live', domain: 'site.example', from: options.busyFrom ?? 'amit', expires_at: Date.now() + 600_000,
    final_url: null, ended_by: null,
  };
  const waiters: (() => void)[] = [];
  const hq: FakeHq = {
    identity: 'amit', created: [], ended: [],
    finish(state) { view.state = state; view.ended_by = 'phone'; waiters.splice(0).forEach(w => w()); },
    async create(req) {
      hq.created.push(req);
      if (options.busyFrom)
        return { ok: false, busy: { ...view }, reason: 'busy' };
      return { ok: true, link: 'https://tab.example/h/abc', handoff: { ...view } };
    },
    async wait(_id, ms) {
      if (view.state === 'live')
        await new Promise<void>(resolve => { waiters.push(resolve); setTimeout(resolve, ms); });
      return { ...view };
    },
    async end(id) { hq.ended.push(id); view.state = 'done'; waiters.splice(0).forEach(w => w()); },
  };
  return hq;
}

{
  const f = fake();
  const hq = fakeHq();
  const sentWith: (string | undefined)[] = [];
  f.deps.handoffs = hq;
  f.deps.ownTarget = () => 'TARGET-1';
  f.deps.ask = async (_title, message, _media, link) => { sentWith.push(link, message); return { ok: true }; };
  setTimeout(() => hq.finish('done'), 1200);
  const started = Date.now();
  const result = await tool(f).handle({ need: 'login', what: 'Sign in', timeoutSeconds: 30 });
  assert.match(result, /pressed "done"/);
  assert.ok(Date.now() - started < 5000, '"done" on the phone wakes it at once, not at the timeout');
  assert.equal(hq.created[0]!['target'], 'TARGET-1', 'the handoff is this session\'s own tab');
  assert.equal(hq.created[0]!['url'], 'https://site.example/login');
  assert.equal(sentWith[0], 'https://tab.example/h/abc');
  assert.match(String(sentWith[1]), /tab\.example\/h\/abc/, 'the link is in the message');
  console.log('  a phone handoff: link in the message, "done" returns at once');
}

{
  const f = fake();
  const hq = fakeHq();
  f.deps.handoffs = hq;
  setTimeout(() => { f.page.text = 'Welcome back'; }, 1600);
  const result = await tool(f).handle({ need: 'login', what: 'Sign in', untilTextGone: 'Verify you are human', timeoutSeconds: 30 });
  assert.match(result, /page changed while waiting/);
  assert.deepEqual(hq.ended, ['h-1'], 'the page saw it first: the handoff is closed so the phone says thanks');
  console.log('  the page watcher seeing it done closes the handoff');
}

{
  const f = fake();
  const hq = fakeHq();
  f.deps.handoffs = hq;
  f.deps.ask = async () => ({ ok: false, reason: 'telegram down' });
  setTimeout(() => hq.finish('done'), 800);
  const result = await tool(f).handle({ need: 'login', what: 'Sign in', timeoutSeconds: 30 });
  assert.match(result, /pressed "done"/, 'with a handoff the link already reached the app: a failed chat message is not fatal');
  assert.match(result, /telegram down/);
  console.log('  a failed chat message is a note, not a dead end, when hq has the link');
}

{
  const f = fake();
  const hq = fakeHq({ busyFrom: 'eli' });
  let asked = 0;
  f.deps.handoffs = hq;
  f.deps.ask = async () => { asked++; return { ok: true }; };
  setTimeout(() => hq.finish('done'), 800);
  const result = await tool(f).handle({ need: 'login', what: 'Sign in', timeoutSeconds: 30 });
  assert.equal(asked, 0, 'a second sign-in to the same site would send a second code');
  assert.match(result, /Another worker \(eli\)/);
  assert.match(result, /probably signed in/);
  console.log('  another worker signing in to the same site: wait for theirs, do not ask');
}

// ── hq is here but refused the link: an error now, never a silent wait (31/10) ─
{
  const f = fake();
  const hq = fakeHq();
  let asked = 0;
  hq.create = async req => { hq.created.push(req); return { ok: false, reason: 'tab T is blank (about:blank#browser-memory-1): select the tab with the page the user must act on, then ask again' }; };
  f.deps.handoffs = hq;
  f.deps.ask = async () => { asked++; return { ok: true }; };
  const started = Date.now();
  await assert.rejects(
      () => tool(f).handle({ need: 'other', what: 'Look at the photo', timeoutSeconds: 120 }),
      (error: Error) => {
        assert.match(error.message, /NOT asked/);
        assert.match(error.message, /is blank/, 'hq\'s reason reaches the agent');
        assert.match(error.message, /Look at the photo/);
        return true;
      });
  assert.ok(Date.now() - started < 3000, 'at once, not after the timeout');
  assert.equal(asked, 0, 'no link-less chat message as if it were asked');
  const at = polls(f);
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(polls(f), at, 'and no watcher left behind');
  console.log('  hq refusing the link is an error at once, not a silent wait');
}

{
  const f = fake();
  const hq = fakeHq();
  hq.create = async () => { throw new Error('connect ECONNREFUSED hq.sock'); };
  f.deps.handoffs = hq;
  await assert.rejects(() => tool(f).handle({ need: 'login', what: 'Sign in', timeoutSeconds: 60 }), /NOT asked.*ECONNREFUSED/s);
  console.log('  hq not answering on its socket is an error too');
}

{
  // The laptop: no hq at all. The chat message is the ask, as before.
  const f = fake();
  const hq = fakeHq();
  let asked = 0;
  hq.create = async () => ({ ok: false, reason: 'hq is not reachable here (no hq.sock)', noHq: true });
  f.deps.handoffs = hq;
  f.deps.ask = async () => { asked++; return { ok: true }; };
  setTimeout(() => { f.page.url = 'https://site.example/done'; }, 1600);
  const result = await tool(f).handle({ need: 'login', what: 'Sign in', timeoutSeconds: 20 });
  assert.equal(asked, 1);
  assert.match(result, /has done it/);
  console.log('  no hq on the machine: the message alone, as before');
}

// ── the phone gets the page the agent is on, not the window it started in ───
{
  const f = fake();
  const hq = fakeHq();
  f.deps.handoffs = hq;
  f.deps.ownTarget = () => 'BLANK-MARKER-WINDOW';
  const call = f.deps.call;
  f.deps.call = async (name, args) => name === 'browser_run_code_unsafe'
    ? text('### Result\n"target:AABCEB92990533E781DD8FE378A30700"')
    : call(name, args);
  setTimeout(() => hq.finish('done'), 800);
  await tool(f).handle({ need: 'login', what: 'Sign in', timeoutSeconds: 30 });
  assert.equal(hq.created[0]!['target'], 'AABCEB92990533E781DD8FE378A30700',
      'the current page, which is what the screenshot showed — not the recorded blank window');
  console.log('  the handoff is the current page, even after the session moved tabs');
}

{
  const f = fake();
  const hq = fakeHq();
  f.deps.handoffs = hq;
  f.deps.ownTarget = () => 'TARGET-1';
  const call = f.deps.call;
  f.deps.call = async (name, args) => {
    if (name === 'browser_run_code_unsafe')
      throw new Error('upstream gone');
    return call(name, args);
  };
  setTimeout(() => hq.finish('done'), 800);
  await tool(f).handle({ need: 'login', what: 'Sign in', timeoutSeconds: 30 });
  assert.equal(hq.created[0]!['target'], 'TARGET-1', 'a page that cannot name itself falls back to the recorded tab');
  console.log('  falls back to the recorded tab when the page cannot say');
}

// ── a message for the agent cancels the call: stop, and leave the ending to hq's mail ─
{
  const f = fake();
  const hq = fakeHq();
  const signals: (AbortSignal | undefined)[] = [];
  const wait = hq.wait.bind(hq);
  hq.wait = async (id, ms, signal) => { signals.push(signal); return wait(id, ms); };
  f.deps.handoffs = hq;
  const client = new AbortController();
  setTimeout(() => client.abort(), 600);
  const started = Date.now();
  const result = await tool(f).handle({ need: 'login', what: 'Sign in', timeoutSeconds: 30 }, client.signal);
  assert.ok(Date.now() - started < 3000, 'a cancelled call stops waiting at once');
  assert.match(result, /ending will arrive as a message/);
  assert.equal(hq.ended.length, 0, 'cancelling the call is not the user finishing: the handoff stays live');
  assert.ok(signals.length && signals.every(s => s === client.signal), 'the long-poll is let go, so hq mails the ending');
  const pollsThen = polls(f);
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.equal(polls(f), pollsThen, 'and the page is no longer watched');
  console.log('  a cancelled call stops at once and leaves the handoff live for hq to report');
}

{
  const f = fake();
  const hq = fakeHq({ busyFrom: 'eli' });
  const wait = hq.wait.bind(hq);
  // Like the real client: a cancelled long-poll rejects at once.
  hq.wait = (id, ms, signal) => new Promise((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    wait(id, ms).then(resolve, reject);
  });
  f.deps.handoffs = hq;
  const client = new AbortController();
  setTimeout(() => client.abort(), 500);
  const started = Date.now();
  await tool(f).handle({ need: 'login', what: 'Sign in', timeoutSeconds: 60 }, client.signal);
  assert.ok(Date.now() - started < 3000, 'cancelled while waiting on another worker\'s sign-in, it lets go at once');
  console.log('  a cancelled wait on another worker\'s sign-in lets go at once');
}

console.log('ASK USER OK');
