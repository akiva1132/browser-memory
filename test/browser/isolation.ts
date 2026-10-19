/**
 * Concurrent agents must not steer each other's pages.
 *
 * Measured before the fix: three agents, and one of them navigated and got back
 * another agent's destination. Playwright tracks a current tab per MCP session,
 * but a fresh session adopts an existing page rather than opening its own, so
 * every agent inherited whatever was in front of it.
 *
 * Needs the browser stack up (chrome-personal + playwright-mcp).
 */
import assert from 'node:assert/strict';

import { Harness, cleanup, tempMemoryDir, textOf } from '../harness.ts';

const CDP = 'http://127.0.0.1:9222/json/list';

async function openTabCount(): Promise<number> {
  const response = await fetch(CDP);
  const targets = await response.json() as { type: string }[];
  return targets.filter(target => target.type === 'page').length;
}

const memoryDir = await tempMemoryDir('isolation');
const before = await openTabCount();

const sites = [
  { url: 'https://example.com/', expect: 'example.com' },
  { url: 'https://www.wikipedia.org/', expect: 'wikipedia.org' },
  { url: 'https://news.ycombinator.com/', expect: 'ycombinator.com' },
];

const agents = await Promise.all(sites.map(() => Harness.start(memoryDir)));

// Every agent navigates at the same time, then each re-reads its own page. If
// tabs were shared, at least one would report a destination it never asked for.
await Promise.all(agents.map((agent, index) =>
  agent.call('browser_navigate', { url: sites[index]!.url })));

const seen = await Promise.all(agents.map(agent =>
  agent.call('browser_evaluate', { function: '() => location.href' }).then(textOf)));

seen.forEach((text, index) => {
  const site = sites[index]!;
  console.log(`agent ${index} → ${site.expect}: ${text.includes(site.expect) ? 'own page' : 'WRONG PAGE'}`);
  assert.ok(text.includes(site.expect),
      `agent ${index} asked for ${site.url} but its page reported:\n${text}`);
});

const during = await openTabCount();
console.log(`tabs: ${before} before, ${during} with three agents running`);
assert.equal(during - before, sites.length, 'each agent should hold exactly one tab of its own');

await Promise.all(agents.map(agent => agent.close()));
// Closing is asynchronous on the browser side; give it a moment to land.
await new Promise(resolve => setTimeout(resolve, 3000));

const after = await openTabCount();
console.log(`tabs after all three disconnected: ${after}`);
assert.ok(after <= before, `agents must hand their tabs back (was ${before}, now ${after})`);

await cleanup(memoryDir);
console.log('\nISOLATION OK');
