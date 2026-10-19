/**
 * The defect this closes was visible on screen: after six benchmark runs the
 * user's browser had four abandoned agent tabs in it, one of them a blank page
 * that had been claimed and never used.
 *
 * Graceful shutdown was never the problem — closing a tab when asked to stop
 * already worked. The problem is every other way a session ends, and the only
 * fix for that is for the *next* session to clean up. So the case that matters
 * here is SIGKILL: no handlers run, nothing is released, and the tab has to be
 * gone anyway once somebody else starts.
 *
 * Runs against the real browser, because the thing being tested is whether a
 * tab actually disappears.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { Harness, cleanup, tempMemoryDir, GATEWAY } from '../harness.ts';
import { TabRegistry } from '../../src/browser/tabs.ts';

const memoryDir = await tempMemoryDir('tabs');
const registry = new TabRegistry(memoryDir, 'test');

const count = async (): Promise<number> => (await registry.targets())?.length ?? 0;

const baseline = await count();
if (!baseline) {
  console.log('SKIPPED — no browser on the CDP endpoint');
  await cleanup(memoryDir);
  process.exit(0);
}

// ── a session that is asked to stop gives its tab back ───────────────────────
{
  const harness = await Harness.start(memoryDir);
  await harness.text('browser_navigate', { url: 'https://example.com' });
  assert.equal(await count(), baseline + 1, 'the session should be holding exactly one tab');
  await harness.close();
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(await count(), baseline, 'a clean shutdown must hand the tab back');
  console.log('  a clean shutdown returns the tab');
}

// ── a session that is killed outright leaves one behind ──────────────────────
let leaked = 0;
{
  const child = spawn('node', [GATEWAY], {
    env: { ...process.env, BROWSER_MEMORY_DIR: memoryDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Speaks MCP over stdio directly: the point is to kill it mid-session, which
  // a client that tidies up on close would prevent.
  const send = (message: unknown): void => void child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await new Promise(resolve => setTimeout(resolve, 1500));
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'browser_navigate', arguments: { url: 'https://example.com' } } });
  await new Promise(resolve => setTimeout(resolve, 9000));

  leaked = await count();
  assert.equal(leaked, baseline + 1, 'the killed session should be holding a tab');
  child.kill('SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(await count(), baseline + 1, 'SIGKILL runs no handlers — the tab is still open');

  const recorded = JSON.parse(await fs.readFile(path.join(memoryDir, 'tabs.json'), 'utf8')) as
    { tabs: { pid: number }[] };
  assert.equal(recorded.tabs.length, 1, 'ownership must have been written down before the kill');
  console.log(`  a killed session leaks its tab, owner pid ${recorded.tabs[0]!.pid} recorded`);
}

// ── and the next session closes it ───────────────────────────────────────────
{
  const harness = await Harness.start(memoryDir);
  await harness.text('browser_navigate', { url: 'https://example.com' });
  // Its own tab, plus the orphan swept on the way in.
  assert.equal(await count(), baseline + 1,
      'the next session must sweep the orphan, not add to the pile');
  await harness.close();
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(await count(), baseline, 'and then give back its own');
  console.log('  the next session sweeps the orphan on the way in');
}

// ── a tab nobody recorded is never touched ───────────────────────────────────
{
  await fs.writeFile(path.join(memoryDir, 'tabs.json'),
      JSON.stringify({ tabs: [{ target: 'NOT-A-REAL-TARGET', pid: 999999, session: 'x', at: '2020-01-01' }] }),
      'utf8');
  assert.equal(await registry.sweep(), 0, 'an unknown target is not something to close');
  assert.equal(await count(), baseline, 'and the user\'s own tabs are untouched throughout');
  console.log('  never closes a tab it did not open');
}

await cleanup(memoryDir);
console.log('TABS OK');
