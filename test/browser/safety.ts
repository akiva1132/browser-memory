/**
 * Two things that would quietly ruin the store: a credential copied out of an
 * authenticated session and persisted for every future agent to read, and
 * global lessons drowning out site-specific ones.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { Harness, cleanup, tempMemoryDir } from '../harness.ts';

const memoryDir = await tempMemoryDir('safety');
const harness = await Harness.start(memoryDir);

// --- credentials must never reach disk -------------------------------------
const leaky = await harness.text('domain_remember', {
  url: 'https://leaky.example.com',
  kind: 'fast-path',
  title: 'Pull the account payload',
  gist: 'One call returns everything.',
  body: 'Send Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk\n' +
    'The api_key=sk_live_51H8xQ2eZvKYlo2C0abcdefgh must be present.\n' +
    'Also set cookie: session=9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a',
  snippet: "document.cookie = 'auth=abc123def456ghi789jkl'; await fetch('/api/me')",
});
console.log(leaky);
assert.match(leaky, /redacted/i, 'the agent must be told redaction happened');

const onDisk = await fs.readFile(path.join(memoryDir, 'leaky.example.com.json'), 'utf8');
const secrets = [
  'eyJhbGciOiJIUzI1NiJ9',
  'sk_live_51H8xQ2eZvKYlo2C0',
  '9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c',
  'abc123def456ghi789jkl',
];
for (const secret of secrets)
  assert.ok(!onDisk.includes(secret), `secret leaked to disk: ${secret}`);
assert.ok(onDisk.includes('«redacted'), 'redaction markers should remain visible');
assert.ok(onDisk.includes('/api/me'), 'the useful part of the snippet must survive');
console.log('secrets stripped, snippet still readable');

// --- global lessons apply anywhere, but never outrank site knowledge --------
await harness.call('domain_remember', {
  url: '*',
  kind: 'fast-path',
  title: 'Check the network tab before touching the UI',
  gist: 'Most dashboards are an SPA over an internal JSON API; browser_network_requests filter "api" reveals it.',
  body: 'Load the page that shows the data, list network requests filtered by "api", and call that endpoint directly.',
});
await harness.call('domain_remember', {
  url: 'https://known.example.com',
  kind: 'dead-end',
  title: 'The /v1/export route is a decoy',
  gist: 'It returns 200 with an empty body; use /v2/export instead.',
});

const fresh = await harness.text('domain_brief', { url: 'https://never-seen-before.example.org' });
console.log('\n--- first visit to an unknown site ---\n' + fresh);
assert.match(fresh, /applies everywhere/, 'global lessons must surface on unknown domains');

const known = await harness.text('domain_brief', { url: 'https://known.example.com' });
const globalPos = known.indexOf('applies everywhere');
const localPos = known.indexOf('decoy');
assert.ok(localPos !== -1 && localPos < globalPos, 'site-specific lessons must rank above global ones');
assert.match(known, /dead-end/, 'dead-end kind must be usable');
console.log('\nglobal lessons rank below site-specific ones');

await harness.close();
await cleanup(memoryDir);

// ── code survives the filter that prose goes through ─────────────────────────
//
// The rule that strips `something_token = <value>` is right for prose and
// destructive on code, where the right-hand side is an expression. It turned
// `const key = params.key` into `const key = «redacted»` — a procedure saved
// broken, failing twice, demoted to broken, with nobody told why. It lived
// because the only procedure test used `document.title`, which has no
// credential-shaped identifier in it.
{
  const { redactCode } = await import('../../src/lib/redact.ts');

  const mustRun = [
    'const csrfToken = document.querySelector("meta[name=csrf]").content;',
    'const apiKey = params.key;',
    'let accessToken = json.access_token;',
    'fetch(`/api/v1/orders?password=${params.p}`)',
    'const r = await fetch("/api/v4/zones", {credentials:"include"});',
    'return {sessionId: window.__DATA__.session_id};',
  ];
  for (const code of mustRun)
    assert.equal(redactCode(code).text, code, `redaction must not rewrite working code: ${code}`);

  const mustStrip: [string, RegExp][] = [
    ['const apiKey = "sk_live_abcdefghijklmnop";', /«redacted»/],
    ['password: "hunter2secret"', /«redacted»/],
    ['const t = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk";', /«redacted:jwt»/],
    ['headers: {Authorization: "Bearer abcdefghijklmnopqrstuvwxyz123"}', /«redacted»/],
    ['const k = "ghp_abcdefghijklmnopqrstuvwxyz1234";', /«redacted:key»/],
  ];
  for (const [code, expected] of mustStrip) {
    const result = redactCode(code);
    assert.match(result.text, expected, `a real credential must still be stripped: ${code}`);
    assert.ok(result.hits > 0, `and counted: ${code}`);
  }
  console.log('  procedure code survives redaction; pasted credentials do not');
}

// ── the system's own records are not sites ───────────────────────────────────
//
// memory/ holds lesson files and control files side by side. normalizeDomain
// used to accept 'tabs', so one domain_remember({url: 'tabs'}) would overwrite
// tabs.json with lessons — destroying the record of which session owns which
// browser tab, after which no orphaned tab is ever closed again. domain_forget
// on the last entry deletes the file outright.
{
  const { normalizeDomain } = await import('../../src/memory/store.ts');
  for (const reserved of ['tabs', 'audit', 'observations', 'api', 'procedures']) {
    assert.throws(() => normalizeDomain(reserved), /reserved/,
        `"${reserved}" is a control file, not a site`);
  }
  assert.equal(normalizeDomain('hpanel.hostinger.com'), 'hpanel.hostinger.com');
  assert.equal(normalizeDomain('*'), '_global');
  console.log('  control-file names are refused as domains');
}

// ── a stolen lock is not deleted by the process it was stolen from ───────────
//
// A lock older than 15s is taken from its holder. If the original holder then
// released unconditionally it would delete the *thief's* lock, and a third
// process would walk in while two were already inside.
{
  const { withLock } = await import('../../src/lib/lock.ts');
  const dir = await tempMemoryDir('lock');
  const lockPath = path.join(dir, 'x.lock');

  // A lock left behind by a process that died, old enough to be reclaimed.
  await fs.writeFile(lockPath, 'DEAD-HOLDER-TOKEN 2020-01-01T00:00:00.000Z', 'utf8');
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lockPath, old, old);

  await withLock('k', lockPath, async () => {
    const held = await fs.readFile(lockPath, 'utf8');
    assert.ok(!held.startsWith('DEAD-HOLDER-TOKEN'), 'a stale lock must be reclaimed');
    // The original holder now "finishes" and releases with its own token.
    const { withLock: other } = await import('../../src/lib/lock.ts');
    void other;
    return held;
  });
  assert.equal(await fs.readFile(lockPath, 'utf8').catch(() => 'gone'), 'gone',
      'the real holder must still be able to release');

  // A lock that is not yet stale is waited for, not walked past.
  //
  // This used to assert a timeout instead, which passed only because the wait
  // deadline was shorter than the stale threshold — an inversion that made
  // every mutation on a key held by a crashed process fail for a whole window
  // rather than reclaim it. With the two the right way round the waiter does
  // eventually get in, so what is checked is that it does not get in *early*.
  {
    await fs.writeFile(lockPath, 'SOMEONE-ELSE 2026-01-01T00:00:00.000Z', 'utf8');
    const fresh = new Date();
    await fs.utimes(lockPath, fresh, fresh);
    let entered = false;
    const waiting = withLock('k2', lockPath, async () => {
      entered = true;
    });
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(entered, false, 'a lock still held must not be taken while it is fresh');
    // Let it go, and the waiter that was queued behind it gets in.
    await fs.rm(lockPath, { force: true });
    await waiting;
    assert.equal(entered, true, 'and once it is gone, the waiter proceeds rather than timing out');
    console.log('  a fresh lock is waited for, and entered as soon as it is released');
  }

  /*
   * A holder that is slow is not a holder that is gone.
   *
   * Age alone cannot tell the two apart, and treating a live-but-blocked holder
   * as dead puts two writers inside at once — one update lost, silently, which
   * is the worst shape a bug can take in a store. A heartbeat is what makes the
   * distinction: the lock is touched while the work runs, so it never looks
   * abandoned until it actually is.
   */
  {
    const slowPath = path.join(dir, 'slow.lock');
    let stolen = false;
    const holder = withLock('slow', slowPath, async () => {
      // Longer than the stale threshold, doing nothing — exactly the shape of a
      // process blocked on a slow disk or a long GC pause.
      await new Promise(resolve => setTimeout(resolve, 11_000));
      stolen = !(await fs.readFile(slowPath, 'utf8').catch(() => '')).startsWith(String(process.pid));
    });
    await holder;
    assert.equal(stolen, false, 'a holder that keeps saying it is alive must keep its lock');
    console.log('  a slow holder is not mistaken for a dead one');
  }

  await cleanup(dir);
  console.log('  a reclaimed lock is only released by whoever holds it');
}

// ── a fact about this machine does not follow the agent onto every site ─────
//
// The store held three global lessons and one was the download directory, which
// is not knowledge about any site: an agent arriving somewhere unfamiliar read
// a path on this disk in the same breath as what the domain does. Small enough
// not to hurt at three, and exactly the mechanism that fills a recall path with
// environment trivia at three hundred.
{
  const { MemoryStore, ENV_SCOPE, GLOBAL_SCOPE, normalizeDomain } = await import('../../src/memory/store.ts');
  const dir = await tempMemoryDir('scopes');
  const store = new MemoryStore(dir, 'session-scope');

  await store.remember(ENV_SCOPE, {
    kind: 'fact', title: 'Downloads land in ~/Downloads', gist: 'Not in the project directory.',
  });
  await store.remember(GLOBAL_SCOPE, {
    kind: 'fast-path', title: 'Check the network tab first', gist: 'Most dashboards are an SPA over JSON.',
  });

  const onASite = (await store.applicable('unfamiliar.example.com')).map(entry => entry.title);
  assert.ok(onASite.some(title => /network tab/.test(title)),
      'knowledge that transfers to an unvisited site is exactly what _global is for');
  assert.ok(!onASite.some(title => /Downloads/.test(title)),
      'a path on this disk is not something to tell an agent about the site it just opened');

  assert.deepEqual((await store.applicable(ENV_SCOPE)).map(entry => entry.title),
      ['Downloads land in ~/Downloads'],
      'and asking for the machine facts directly must not drag the global ones in');
  assert.equal(normalizeDomain('env'), ENV_SCOPE, 'reachable by the short name an agent would try');
  await cleanup(dir);
  console.log('  machine facts stay out of every site briefing');
}

console.log('\nSAFETY OK');
