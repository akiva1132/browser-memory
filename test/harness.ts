import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { gatewayEntry } from '../src/lib/roots.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bodyOf } from '../src/lib/toolResult.ts';
import type { ToolResult } from '../src/lib/toolResult.ts';
export type { ToolResult };

/**
 * Shared plumbing for the end-to-end tests. Everything here talks to a real
 * gateway over stdio — the same path Claude uses — because the failures worth
 * catching (schemas that serialize empty, locks that do not hold across
 * processes) only appear at that boundary.
 */

// fileURLToPath, not URL.pathname: the project directory has a space in it and
// pathname hands back %20, which resolves to a path that does not exist.

export const GATEWAY = gatewayEntry;

export type AdvertisedTool = {
  name: string;
  description?: string;
  inputSchema: { properties?: Record<string, unknown> };
};

export class Harness {
  // Declared rather than a constructor parameter property: Node strips types
  // without transforming, so only erasable syntax runs here.
  private readonly _client: Client;

  private constructor(client: Client) {
    this._client = client;
  }

  /**
   * @param env extra variables for the gateway process. Used by the ablation
   *   test, where the whole point is that one arm starts with a switch set and
   *   an otherwise identical one does not.
   */
  static async start(memoryDir: string, env: Record<string, string> = {}): Promise<Harness> {
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new StdioClientTransport({
      command: 'node',
      args: [GATEWAY],
      env: { ...process.env, BROWSER_MEMORY_DIR: memoryDir, ...env } as Record<string, string>,
    }));
    return new Harness(client);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return await this._client.callTool({ name, arguments: args }) as ToolResult;
  }

  /** Tool output as the agent would read it. */
  async text(name: string, args: Record<string, unknown> = {}): Promise<string> {
    return textOf(await this.call(name, args));
  }

  async tools(): Promise<AdvertisedTool[]> {
    return (await this._client.listTools()).tools as unknown as AdvertisedTool[];
  }

  async toolNames(): Promise<string[]> {
    return (await this.tools()).map(tool => tool.name);
  }

  async close(): Promise<void> {
    await this._client.close();
  }
}

export const textOf = bodyOf;

export const tempMemoryDir = (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `browser-memory-${label}-`));

export const cleanup = (dir: string): Promise<void> =>
  fs.rm(dir, { recursive: true, force: true });

/**
 * The recorded steps, read back out of the lesson that carries them.
 *
 * There used to be a second, structured copy of every flow — a trajectory an
 * engine could replay — and the tests asserted against that because it was the
 * convenient shape. It is gone: offered to twelve agents on the one form it
 * could have helped with and used by none, and uncapturable on the sites where
 * it might have paid, because agents route around Playwright's actionability
 * checks through `browser_evaluate` and every such step is invisible to the
 * recorder.
 *
 * The properties those tests were protecting are still worth protecting — every
 * step present and in order, addresses that survive a restyle, and no typed
 * value ever reaching disk. So they are checked against the artifact that
 * actually ships now, which is the right place for them to have been all along.
 */
export type RecordedStep = { tool: string; element: string; target: string; anchored: boolean };

export function stepsIn(body: string): RecordedStep[] {
  const block = /```\n([\s\S]*?)\n```/.exec(body)?.[1] ?? '';
  const lines = block.split('\n');
  const out: RecordedStep[] = [];
  for (const [index, line] of lines.entries()) {
    // A step is a `tool  element` line; its address is the indented line under
    // it, and `── the page becomes /x ──` marks a page boundary rather than a
    // step.
    const head = /^([a-z_]+)\s+(.*)$/.exec(line);
    if (!head || line.startsWith(' ') || line.startsWith('──'))
      continue;
    const target = (lines[index + 1] ?? '').trim();
    out.push({
      tool: `browser_${head[1]}`,
      element: head[2]!.trim(),
      target: target.replace(/\s+←.*$/, ''),
      anchored: !target.includes('← css'),
    });
  }
  return out;
}
