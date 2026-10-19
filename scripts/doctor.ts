#!/usr/bin/env node
/**
 * Is the stack healthy enough to start a ten-minute job?
 *
 * Asked before the job, not after. Three measured runs were spent discovering
 * mid-flight that the browser had wedged — the first of them for its full
 * ten-minute ceiling — and every one of those minutes was avoidable, because
 * the answer was already available in under a second from the ports involved.
 *
 * `Restart=always` does not cover this. The upstream process was alive the
 * whole time; it was alive and not answering, which is the failure mode a
 * process supervisor cannot see and a round trip can.
 *
 *   node scripts/doctor.ts            report everything
 *   node scripts/doctor.ts --quiet    say nothing unless something is wrong
 *
 * Exits non-zero when the stack cannot do work, so it can gate a job.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { defaultMemoryDir } from '../src/lib/roots.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const CDP = process.env['BROWSER_CDP_URL'] || 'http://127.0.0.1:9222';
const UPSTREAM = process.env['PLAYWRIGHT_MCP_URL'] || 'http://localhost:8931/mcp';
const MEMORY = defaultMemoryDir;

const quiet = process.argv.includes('--quiet');

type Result = { name: string; ok: boolean; detail: string; fatal: boolean };

const results: Result[] = [];
const check = async (
  name: string, fatal: boolean, run: () => Promise<string>,
): Promise<void> => {
  try {
    results.push({ name, ok: true, detail: await run(), fatal });
  } catch (error) {
    results.push({ name, ok: false, detail: (error as Error).message, fatal });
  }
};

/** Every probe is bounded: a check that can hang is the thing being checked for. */
async function within<T>(ms: number, label: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await work(controller.signal);
  } catch (error) {
    throw controller.signal.aborted ? new Error(`${label} did not answer within ${ms}ms`) : error;
  } finally {
    clearTimeout(timer);
  }
}

await check('chrome responds on CDP', true, async () => {
  const version = await within(3000, 'CDP', async signal =>
    (await fetch(`${CDP}/json/version`, { signal })).json() as Promise<{ Browser?: string }>);
  return version.Browser ?? 'unknown build';
});

await check('a page target can be listed', true, async () => {
  const targets = await within(3000, 'CDP target list', async signal =>
    (await fetch(`${CDP}/json/list`, { signal })).json() as Promise<{ type: string; url: string }[]>);
  const pages = targets.filter(target => target.type === 'page');
  return `${pages.length} page(s), ${targets.length} target(s)`;
});

await check('the MCP server lists its tools', true, async () => {
  const client = new Client({ name: 'doctor', version: '1.0.0' }, { capabilities: {} });
  return await within(8000, 'the MCP server', async () => {
    await client.connect(new StreamableHTTPClientTransport(new URL(UPSTREAM)));
    try {
      const { tools } = await client.listTools();
      return `${tools.length} tools`;
    } finally {
      await client.close().catch(() => {});
    }
  });
});

await check('the browser answers through MCP', true, async () => {
  /*
   * The check that matters, and the one this file did not have when it was
   * first written.
   *
   * The wedged upstream answered `tools/list` perfectly — 63 tools, instantly —
   * while every browser operation hung until its client gave up. A doctor that
   * asks the server about itself is asking the wrong question: it proves the
   * process is alive and serving metadata, which was never in doubt. Only a
   * request that has to reach Chrome distinguishes a working stack from one
   * that is up and useless.
   *
   * `browser_tabs` is the cheapest such request — it enumerates what is already
   * open, navigates nothing, and touches no page.
   */
  const client = new Client({ name: 'doctor', version: '1.0.0' }, { capabilities: {} });
  return await within(15_000, 'a browser operation', async () => {
    await client.connect(new StreamableHTTPClientTransport(new URL(UPSTREAM)));
    try {
      const result = await client.callTool(
          { name: 'browser_tabs', arguments: { action: 'list' } },
          undefined,
          { timeout: 12_000 }) as { isError?: boolean; content?: { text?: string }[] };
      if (result.isError)
        throw new Error((result.content ?? []).map(part => part.text ?? '').join(' ').slice(0, 120));
      return 'a real browser call round-tripped';
    } finally {
      await client.close().catch(() => {});
    }
  });
});

await check('memory is writable', true, async () => {
  await fs.mkdir(MEMORY, { recursive: true });
  const probe = path.join(MEMORY, `.doctor-${process.pid}`);
  await fs.writeFile(probe, 'ok', 'utf8');
  await fs.rm(probe, { force: true });
  return path.relative(process.cwd(), MEMORY);
});

await check('no tabs are owned by dead processes', false, async () => {
  const raw = await fs.readFile(path.join(MEMORY, 'tabs.json'), 'utf8').catch(() => '{"tabs":[]}');
  const { tabs } = JSON.parse(raw) as { tabs?: { pid: number }[] };
  const orphans = (tabs ?? []).filter(tab => {
    try {
      process.kill(tab.pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  if (orphans.length)
    throw new Error(`${orphans.length} tab(s) still registered to processes that have exited`);
  return `${(tabs ?? []).length} tracked`;
});

const failed = results.filter(result => !result.ok);
const fatal = failed.filter(result => result.fatal);

if (!quiet || failed.length) {
  for (const result of results)
    console.log(`  ${result.ok ? '✓' : result.fatal ? '✖' : '!'} ${result.name.padEnd(36)} ${result.detail}`);
}

if (fatal.length) {
  console.error(
      `\n✖ the browser stack cannot do work right now.\n` +
      `  systemctl --user restart playwright-mcp.service\n` +
      `  then run this again before starting anything long.`);
  process.exit(1);
}
if (!quiet)
  console.log(failed.length ? '\nUsable, with warnings above.' : '\nHealthy.');
