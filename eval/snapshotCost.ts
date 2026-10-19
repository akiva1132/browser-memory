/**
 * What does the accessibility tree actually cost?
 *
 * The upgrade plan calls the full snapshot on every action the number one token
 * problem, citing 50–540KB per snapshot and 114K tokens against 27K for the
 * same task through a CLI. Those are somebody else's numbers on somebody else's
 * pages. Before rebuilding the response path around them, they need checking
 * here — the last thing that looked this obviously right was pruning the tool
 * surface, which saved a measured 12.9k tokens and lost the A/B anyway.
 *
 * Three questions, in order of how badly a wrong answer would hurt:
 *
 *   1. How big is a snapshot on pages this browser actually visits? If the
 *      answer is single-digit KB, the rest of the phase is not worth building.
 *
 *   2. Is a snapshot of an unchanged page the same snapshot twice? Diffing
 *      assumes the tree is stable when nothing happens. A page with a clock, a
 *      carousel or a lazy list would make every diff report churn, and the
 *      saving would evaporate exactly on the busy pages it was built for.
 *
 *   3. Do refs survive a second snapshot? The plan's diff design rests on
 *      "the refs stay valid because they come from the same upstream snapshot".
 *      If ids are reassigned per snapshot, a diff that omits unchanged nodes
 *      hands the agent refs it can no longer use, and the design has to change.
 *
 * Read-only: navigation and snapshots, no clicking. It runs against real pages
 * because that is the only place the answer lives, and against a throwaway
 * memory directory because a measurement that writes into the store makes every
 * later measurement a liar.
 */
import { Harness, textOf, cleanup, tempMemoryDir } from '../test/harness.ts';

/** A page nobody has to be logged in to, and two the store already knows. */
const PAGES = process.argv.slice(2).length ? process.argv.slice(2) : [
  'https://example.com',
  'https://news.ycombinator.com',
  'https://en.wikipedia.org/wiki/Accessibility_tree',
];

const REF_LINE = /^\s*-\s+([a-zA-Z]+)(\s+"(?:[^"\\]|\\.)*")?((?:\s*\[[^\]\n]*\])+)/;
const REF_ATTR = /\[ref=((?:f\d+)?e\d+)\]/;

/** ref → the node it named, by the same reading the observer does. */
function refs(body: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of body.split('\n')) {
    const node = REF_LINE.exec(line);
    const ref = node && REF_ATTR.exec(node[3] ?? '')?.[1];
    if (node && ref)
      found.set(ref, `${node[1]}${node[2] ?? ''}`);
  }
  return found;
}

/**
 * How much of the second snapshot is text the first one already had. Compared
 * as a multiset of lines, so a section moving does not read as a rewrite while
 * a section changing still does.
 */
function unchanged(before: string, after: string): number {
  const pool = new Map<string, number>();
  for (const line of before.split('\n'))
    pool.set(line, (pool.get(line) ?? 0) + 1);
  let same = 0;
  const lines = after.split('\n');
  for (const line of lines) {
    const left = pool.get(line) ?? 0;
    if (left > 0) {
      pool.set(line, left - 1);
      same += 1;
    }
  }
  return lines.length ? same / lines.length : 1;
}

/** Roughly four characters to a token; exact enough to decide whether to care. */
const tokens = (chars: number): string => `${Math.round(chars / 4 / 100) / 10}k`;
const kb = (chars: number): string => `${(chars / 1024).toFixed(1)}KB`;

const memoryDir = await tempMemoryDir('snapcost');
const harness = await Harness.start(memoryDir);

console.log('page                                      nav reply   snapshot   2nd snap   same   refs kept');
console.log('─'.repeat(96));

const rows: { page: string; nav: number; snap: number; same: number; kept: number }[] = [];

for (const url of PAGES) {
  const navigation = textOf(await harness.call('browser_navigate', { url }));
  // Two snapshots of a page nobody touched in between. Any difference between
  // them is the page moving on its own, which is the noise floor a diff has to
  // clear before it can claim to be reporting a change.
  const first = textOf(await harness.call('browser_snapshot'));
  const second = textOf(await harness.call('browser_snapshot'));

  const before = refs(first);
  const after = refs(second);
  let kept = 0;
  for (const [ref, node] of before) {
    if (after.get(ref) === node)
      kept += 1;
  }

  const same = unchanged(first, second);
  const keptRatio = before.size ? kept / before.size : 1;
  rows.push({ page: url, nav: navigation.length, snap: first.length, same, kept: keptRatio });

  const host = new URL(url).host + new URL(url).pathname;
  console.log(
      `${host.slice(0, 40).padEnd(40)}  ${kb(navigation.length).padStart(9)}  ` +
      `${kb(first.length).padStart(9)}  ${kb(second.length).padStart(9)}  ` +
      `${(same * 100).toFixed(0).padStart(4)}%  ${(keptRatio * 100).toFixed(0).padStart(8)}%  ` +
      `(${before.size} refs, ~${tokens(first.length)} tokens)`);
}

console.log('─'.repeat(96));

/*
 * The premise of the whole phase: "a full snapshot on every action". Worth
 * checking rather than inheriting, because if this upstream already answers an
 * action with a summary, the expensive half of the plan is already built and
 * the work is to stop asking for trees rather than to shrink them.
 *
 * Both actions are addressed by role and name — the form this store now writes
 * — so the reply also says whether what is being saved can be replayed.
 */
const actions: [string, string, Record<string, unknown>][] = [
  ['click a link', 'browser_click',
    { element: 'Learn more link', target: 'role=link[name="Learn more"]' }],
  ['type into a box', 'browser_type',
    { element: 'Search box', target: 'role=searchbox[name="Search Wikipedia"]', text: 'aria' }],
];

for (const [what, tool, args] of actions) {
  const page = tool === 'browser_click' ? 'https://example.com' : 'https://en.wikipedia.org/wiki/Main_Page';
  await harness.call('browser_navigate', { url: page });
  const reply = await harness.call(tool, args);
  const body = textOf(reply);
  console.log(
      `${what.padEnd(20)} ${reply.isError ? 'FAILED: ' + body.split('\n')[0]?.slice(0, 60) : `reply ${kb(body.length).padStart(8)} ` +
      `(~${tokens(body.length)} tokens)${/\[ref=/.test(body) ? '  — carries a tree' : '  — no tree'}`}`);
}

console.log('─'.repeat(96));

const median = (values: number[]): number =>
  values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

const snapshots = rows.map(row => row.snap);
const navs = rows.map(row => row.nav);
console.log(
    `median snapshot ${kb(median(snapshots))} (~${tokens(median(snapshots))} tokens), ` +
    `median navigation reply ${kb(median(navs))}`);
console.log(
    `an unchanged page re-snapshots ${(median(rows.map(row => row.same)) * 100).toFixed(0)}% identical, ` +
    `keeping ${(median(rows.map(row => row.kept)) * 100).toFixed(0)}% of its refs`);

await harness.close();
await cleanup(memoryDir);
