/**
 * The one thing this must never do is tell an agent "unchanged" about a page
 * that changed, or about a tree the agent cannot see any more. Everything below
 * is a way of getting it to do one of those two.
 *
 * The bodies are the real reply shape, copied from a live call: tabs, then the
 * page block, then a fenced yaml tree.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  collapseRepeat, MAX_DISTANCE, snapshotWithin, treeOf, urlOf,
} from '../../src/browser/repeat.ts';
import { cleanup, tempMemoryDir } from '../harness.ts';

const reply = (url: string, tree: string): string =>
  `### Open tabs\n- 0: (current) [Example Domain](${url})\n` +
  `### Page\n- Page URL: ${url}\n- Page Title: Example Domain\n` +
  `### Snapshot\n\`\`\`yaml\n${tree}\n\`\`\``;

const TREE = [
  '- generic [ref=e2]:',
  '  - heading "Example Domain" [level=1] [ref=e3]',
  '  - link "Learn more" [ref=e6] [cursor=pointer]:',
  '    - /url: https://iana.org/domains/example',
].join('\n');

/**
 * A page big enough that not sending it twice is worth a sentence. Hacker News
 * measured 610 nodes and ~12.4k tokens; this is the same shape, smaller.
 */
const BIG_TREE = [
  '- generic [ref=e2]:',
  ...Array.from({ length: 60 }, (_unused, index) =>
    `  - link "Story number ${index} about something or other" [ref=e${index + 10}] [cursor=pointer]`),
].join('\n');

const PAGE = reply('https://example.com/', BIG_TREE);
const TINY = reply('https://example.com/', TREE);

// ── it reads the real reply shape ────────────────────────────────────────────
assert.equal(treeOf(TINY), TREE, 'the fenced tree is what gets collapsed');
assert.equal(urlOf(PAGE), 'https://example.com/');
assert.equal(treeOf('### Result\nnothing here'), undefined, 'a reply with no tree is not a snapshot');
// The heading has been spelled both ways across versions; a reply that stopped
// matching would disable this silently rather than fail.
assert.ok(treeOf(PAGE.replace('### Snapshot', '### Page Snapshot')), 'both spellings of the heading');

// ── the same page twice: the second one is not sent again ────────────────────
{
  const collapsed = collapseRepeat(PAGE, { url: 'https://example.com/', tree: BIG_TREE, at: 4 }, 5);
  assert.ok(collapsed, 'an identical tree is the case this exists for');
  assert.ok(!collapsed.includes('Story number 7'), 'the tree itself must not be sent twice');
  assert.match(collapsed, /Unchanged/);
  assert.match(collapsed, /61 elements/,
      'what was withheld has to be described by what the agent can still address, not by line count');
  assert.match(collapsed, /previous call/, 'and where the agent can find it');
  assert.match(collapsed, /refs in it are still valid/,
      'measured: an unchanged page keeps 100% of its refs, and the agent has to be told');
  // The header is the part that is genuinely fresh — a tab may have opened.
  assert.match(collapsed, /### Open tabs/);
  assert.match(collapsed, /Page URL: https:\/\/example\.com\//);
  console.log(`  a repeat of an unchanged page: ${PAGE.length} chars → ${collapsed.length}`);
}

// ── anything that is not exactly the same page is sent in full ───────────────
{
  const cases: [string, string | undefined][] = [
    ['one node differs', collapseRepeat(
        PAGE, { url: 'https://example.com/', tree: `${BIG_TREE}\n  - button "New" [ref=e9]`, at: 4 }, 5)],
    ['same tree, different URL', collapseRepeat(
        PAGE, { url: 'https://example.org/', tree: BIG_TREE, at: 4 }, 5)],
    ['nothing seen before', collapseRepeat(PAGE, undefined, 5)],
    ['too far back to still have it', collapseRepeat(
        PAGE, { url: 'https://example.com/', tree: BIG_TREE, at: 1 }, 2 + MAX_DISTANCE)],
    // The explanation is longer than four lines of yaml: sending it would be a
    // worse answer at a higher price.
    ['a page too small to be worth a sentence', collapseRepeat(
        TINY, { url: 'https://example.com/', tree: TREE, at: 4 }, 5)],
    ['a reply with no tree in it', collapseRepeat(
        '### Result\nclicked', { url: 'https://example.com/', tree: TREE, at: 4 }, 5)],
  ];
  for (const [what, result] of cases)
    assert.equal(result, undefined, `${what}: must be answered in full`);
  console.log('  a changed page, a different page, a forgotten one — all sent in full');
}

// ── the boundary is inclusive, so the last reachable call still collapses ────
{
  const atEdge = collapseRepeat(PAGE, { url: 'https://example.com/', tree: BIG_TREE, at: 1 }, 1 + MAX_DISTANCE);
  assert.ok(atEdge, 'exactly at the limit is still within reach');
  assert.match(atEdge, new RegExp(`${MAX_DISTANCE} calls ago`), 'and says how far back');
  console.log(`  the reach is ${MAX_DISTANCE} calls, inclusive`);
}

/*
 * ── a linked snapshot path is confined to the output directory ──────────────
 *
 * The path comes out of a tool reply, and the reply to `browser_evaluate`
 * embeds whatever the page returned — so a hostile page can write
 * `- [Snapshot](…)` into a string and choose the file the gateway reads. What
 * it reads is handed to the observer as an accessibility tree and can end up
 * stored as the targets of a lesson.
 *
 * Both of the cases below passed the check this replaces, which tested
 * `resolved.startsWith(base)`.
 */
{
  const root = await tempMemoryDir('confine');
  const output = path.join(root, '.playwright-mcp');
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'page.yml'), '- generic [ref=e1]\n', 'utf8');

  const ok = await snapshotWithin(output, '.playwright-mcp/page.yml');
  assert.ok('file' in ok, 'an ordinary linked snapshot still resolves');

  const escaped = await snapshotWithin(output, '../../../../etc/passwd');
  assert.ok('refused' in escaped, 'climbing out is refused');

  // A prefix is not a directory boundary: `<base>-evil` starts with `<base>`.
  const sibling = path.join(root, '.playwright-mcp-evil');
  await fs.mkdir(sibling, { recursive: true });
  await fs.writeFile(path.join(sibling, 'page.yml'), 'x', 'utf8');
  const neighbour = await snapshotWithin(output, '.playwright-mcp-evil/page.yml');
  assert.ok('refused' in neighbour,
      'a directory whose name merely starts the same way is not inside it');

  // A symlink inside the directory points wherever it likes, and only realpath
  // sees through it.
  const secret = path.join(root, 'secret.txt');
  await fs.writeFile(secret, 'private', 'utf8');
  await fs.symlink(secret, path.join(output, 'link.yml'));
  const followed = await snapshotWithin(output, '.playwright-mcp/link.yml');
  assert.ok('refused' in followed, 'and a symlink out of it is followed and refused');

  await cleanup(root);
  console.log('  a linked snapshot outside the output directory is refused, symlinks included');
}

/**
 * The link is relative and the upstream does not say what to, so more than one
 * starting directory is tried. The point of these three is that widening the
 * search does not widen what can be read: containment is the gate, and the
 * extra candidate is subject to it exactly like the first.
 */
{
  const root = await tempMemoryDir('bases');
  const output = path.join(root, 'work', 'output');
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'page.yml'), '- generic [ref=e1]\n', 'utf8');
  await fs.writeFile(path.join(root, 'secret.txt'), 'private', 'utf8');

  const beside = await snapshotWithin(output, 'output/page.yml', [root]);
  assert.ok('file' in beside, 'a link naming the output directory resolves against its parent');

  const fromRoot = await snapshotWithin(output, 'work/output/page.yml', [root]);
  assert.ok('file' in fromRoot, 'and one written from the project root resolves against that');

  const stolen = await snapshotWithin(output, 'secret.txt', [root]);
  assert.ok('refused' in stolen,
      'a second base does not make a file outside the output directory readable');

  await cleanup(root);
  console.log('  either directory the link may be relative to, neither able to escape');
}

console.log('REPEAT OK');
