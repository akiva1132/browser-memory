/**
 * The behaviour that makes this worth having is that it releases on its own.
 * A hand-off that requires the user to solve the CAPTCHA *and then* come back
 * to a chat window and type "done" is worse than no hand-off — people stop
 * using it and go back to doing the whole task themselves.
 *
 * So the cases below are mostly about when it returns and when it refuses to:
 * on a page change with no reply at all, on a reply with no page change, and
 * — the one that would silently ruin it — never just because the client had no
 * way to ask.
 *
 * Driven with a fake browser, because the interesting states (a client that
 * cannot elicit, a user who never answers) are precisely the ones that are hard
 * to stage against a real one.
 */
import assert from 'node:assert/strict';

import { askUserTools } from '../../src/browser/askUser.ts';
import type { AskDeps, ToolResult } from '../../src/browser/askUser.ts';

type Fake = {
  deps: AskDeps;
  calls: { name: string; args: Record<string, unknown> }[];
  page: { url: string; text: string };
};

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });

/** `ask` never resolving is the normal case: most users just act on the page. */
function fake(options: { ask?: () => Promise<boolean> } = {}): Fake {
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
      ask: options.ask ?? (() => new Promise<boolean>(() => {})),
    },
  };
}

const tool = (f: Fake) => askUserTools(f.deps)[0]!;

// ── it raises the agent's own tab, not whichever one is on screen ────────────
{
  const f = fake({ ask: async () => true });
  await tool(f).handle({ need: 'captcha', what: 'Tick the box' });
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

// ── a reply releases it even if the page looks unchanged ─────────────────────
{
  const f = fake({ ask: async () => true });
  const result = await tool(f).handle({
    need: 'form-field', what: 'Fill in the VAT number', untilTextGone: 'Verify you are human',
    timeoutSeconds: 20,
  });
  assert.match(result, /has done it/);
  assert.doesNotMatch(result, /page changed/, 'nothing on the page moved; do not claim it did');
  console.log('  a reply releases it with no page change');
}

// ── the failure that would quietly ruin it ───────────────────────────────────
{
  const f = fake({ ask: async () => false });
  const started = Date.now();
  setTimeout(() => { f.page.text = 'Welcome back'; }, 2000);
  const result = await tool(f).handle({
    need: 'captcha', what: 'Tick the box', untilTextGone: 'Verify you are human', timeoutSeconds: 20,
  });
  assert.ok(Date.now() - started > 1500,
      'a client that cannot ask must not be read as the user saying "no, carry on"');
  assert.match(result, /has done it/, 'the page watcher is what releases it when nobody can be asked');
  console.log('  a client that cannot elicit still waits for the page');
}

// ── giving up says so, without failing the task ──────────────────────────────
{
  const f = fake();
  const result = await tool(f).handle({
    need: 'captcha', what: 'Tick the box', untilTextGone: 'Verify you are human', timeoutSeconds: 5,
  });
  assert.match(result, /has not been done yet/);
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
  assert.match(result, /has not been done yet/,
      'text that was already absent would otherwise report success in zero seconds');
  console.log('  an already-satisfied condition does not fake instant success');
}

// ── nothing to wait for is answered now, not in three minutes ───────────────
//
// Both signals gone at once: the marker was already true before anyone was
// asked, so the page watcher stands down, and the client cannot elicit, so no
// reply is coming either. That left the expiry timer alone in the race — the
// tool sat out its whole timeout, up to fifteen minutes by default, over a
// condition it had already decided it could not measure.
{
  const f = fake({ ask: async () => false });
  const started = Date.now();
  const result = await tool(f).handle({
    need: 'login', what: 'Sign in with your Google account',
    // Already on the page before anyone was asked, so it can never mark the
    // change it was given to mark.
    untilTextAppears: 'Verify you are human', timeoutSeconds: 60,
  });
  const waited = Date.now() - started;
  assert.ok(waited < 5_000, `must not sit out the timeout with nothing to wait for — waited ${waited}ms`);
  assert.match(result, /no way to tell when it is finished/);
  assert.match(result, /untilTextAppears/, 'the useless marker is the thing to name');
  assert.ok(!/user has done it/.test(result),
      'and it must not claim success: nothing here is evidence either way');
  console.log(`  no signal either way: answered in ${waited}ms instead of 60s`);
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

console.log('ASK USER OK');
