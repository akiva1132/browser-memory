#!/usr/bin/env node
/**
 * Everything this gateway is offering right now, and where each thing came from.
 *
 * An agent meets the tool list as a flat sequence of names with descriptions,
 * and so did everybody else. Three of those groups are not the same kind of
 * thing at all: the memory tools are written and reviewed, the browser tools
 * belong to somebody else's server, and a handful were generated — a procedure
 * a person saved, or a flow the recorder captured on its own while an agent was
 * busy doing something else. Nothing distinguished them, so "what do I actually
 * have" had no answer short of reading the store by hand.
 *
 *   node scripts/explain.ts [memory-dir] [--full]
 *
 * `--full` prints every browser tool as well; by default they are counted,
 * because sixty-three names nobody here wrote is the noise this exists to cut.
 *
 * The generated ones get their provenance from the store rather than from the
 * tool list, because the list cannot carry it: when it was recorded, by which
 * session, and every step in order.
 */
import path from 'node:path';

import { defaultMemoryDir, gatewayEntry } from '../src/lib/roots.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { ProcedureStore } from '../src/procedures/store.ts';

const UPSTREAM = process.env['PLAYWRIGHT_MCP_URL'] || 'http://localhost:8931/mcp';
const argv = process.argv.slice(2);
const full = argv.includes('--full');
const memoryDir = argv.find(arg => !arg.startsWith('--'))
  ?? defaultMemoryDir;

const colour = process.stdout.isTTY && !process.env['NO_COLOR'];
const paint = (code: string, text: string): string => colour ? `[${code}m${text}[0m` : text;
const bold = (text: string): string => paint('1', text);
const dim = (text: string): string => paint('2', text);

/** One sentence, for a list where the point is to scan rather than to read. */
const firstSentence = (text = ''): string => {
  const end = /(?<=\.)\s/.exec(text);
  return end ? text.slice(0, end.index + 1) : text;
};

const wrap = (text: string, indent: string, width = 96): string =>
  text.split(' ').reduce((lines, word) => {
    const last = lines[lines.length - 1]!;
    if ((last + ' ' + word).trim().length > width)
      lines.push(indent + word);
    else
      lines[lines.length - 1] = (last + ' ' + word).trimEnd();
    return lines;
  }, [indent]).join('\n');

const client = new Client({ name: 'explain', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: 'node',
  args: [gatewayEntry],
  env: { ...process.env, BROWSER_MEMORY_DIR: memoryDir } as Record<string, string>,
}));
const { tools } = await client.listTools();

// Read alongside, because provenance is the question and the tool list has none
// of it: a saved procedure is the one kind of tool nobody typed into this repo.
const saved = await new ProcedureStore(path.join(memoryDir, 'procedures'), 'explain')
    .all().catch(() => []);
const procedureNames = new Set(saved.map(procedure => procedure.name));

/*
 * Which tools are genuinely the upstream's, asked rather than guessed.
 *
 * The prefix is not the answer: `browser_ask_user` and `browser_resume` are
 * ours, deliberately named to sit among the browser tools so an agent reaches
 * for them at the moment it hits a CAPTCHA. Classifying by name filed them
 * under somebody else's server, which is the one claim this script exists to
 * get right.
 */
const upstream = new Client({ name: 'explain', version: '1.0.0' }, { capabilities: {} });
const theirs = await upstream.connect(new StreamableHTTPClientTransport(new URL(UPSTREAM)))
    .then(() => upstream.listTools())
    .then(({ tools: remote }) => new Set(remote.map(tool => tool.name)))
    .catch(() => undefined);
await upstream.close().catch(() => {});
const isBrowser = (name: string): boolean =>
  theirs ? theirs.has(name) : name.startsWith('browser_');

const memory = tools.filter(tool =>
  !isBrowser(tool.name) && !procedureNames.has(tool.name));
const browser = tools.filter(tool => isBrowser(tool.name));

console.log(`\n${bold('memory')}  ${memoryDir}`);
console.log(`${bold('serving')} ${tools.length} tools: ${memory.length} memory · ` +
  `${procedureNames.size} saved procedure(s) · ${browser.length} browser\n`);

console.log(bold('── written by hand, and part of the product ─────────────────────────────────'));
for (const tool of memory)
  console.log(`  ${paint('36', tool.name.padEnd(20))} ${dim(firstSentence(tool.description))}`);

console.log(`\n${bold('── saved by a person, and reviewed when it was saved ────────────────────────')}`);
if (!saved.length)
  console.log(dim('  (none)'));
for (const procedure of saved) {
  console.log(`  ${paint('33', procedure.name)}  ${dim(`on ${procedure.origin}, saved ${procedure.created}` +
    `${procedure.by ? ` by session ${procedure.by}` : ''} · ${procedure.status}` +
    `${procedure.runs ? ` · ${procedure.ok}/${procedure.runs} runs ok` : ' · never run'}` +
    `${procedure.mutating ? ' · needs confirm: true' : ''}`)}`);
  console.log(wrap(procedure.description ?? '', '    '));
  if (procedure.findings.length) {
    console.log(paint('31', `    static review flagged: ${procedure.findings
      .map(finding => `${finding.rule} — ${finding.why}`).join('; ')}`));
  }
}

console.log(`\n${bold('── proxied from the browser server, and not ours ────────────────────────────')}`);
if (full) {
  for (const tool of browser)
    console.log(`  ${dim(tool.name.padEnd(28))} ${dim(firstSentence(tool.description))}`);
} else {
  console.log(dim(`  ${browser.length} tools. Re-run with --full to list them.`));
}
console.log();

await client.close();
