import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * A snapshot the agent is already holding.
 *
 * Measured before this was written, because the plan it comes from asserts that
 * the accessibility tree is returned on every action and that this is the
 * largest cost in the system. On this browser server that is no longer true: an
 * action answers in 0.1–0.5KB and carries no tree at all. What remains is the
 * tree the agent asks for by name, and there the numbers are real — 3.4k tokens
 * on a Wikipedia article, 12.4k on a Hacker News front page, paid again in
 * every turn that follows, because each turn re-reads the whole conversation.
 *
 * The part worth removing is narrower than "the snapshot", and it showed up in
 * the audit log: of 15 snapshots in the one long working session, 12 were taken
 * with no navigation since the last one. Re-reading a page that has not changed
 * is the whole cost with none of the information.
 *
 * So this collapses one specific case and no others: the tree is byte-identical
 * to the one this session already returned, for the same URL, recently enough
 * that the agent still has it. That case is lossless — the text being withheld
 * is text already sitting in the agent's context — which is what separates it
 * from the last thing that looked like a saving here. Pruning the tool surface
 * saved a measured 12.9k tokens and lost the A/B anyway, because it removed
 * capability and the agent bought it back in extra turns. Nothing is removed
 * here; the same bytes are simply not sent twice.
 *
 * Everything else passes through untouched. A tree that differs by one node is
 * returned in full, because deciding which parts of a changed page the agent
 * needs is a judgement this layer has no standing to make.
 */

/**
 * The fenced tree in a browser reply. Both spellings, because the heading has
 * been `### Page Snapshot` and is now `### Snapshot`, and a reply that stops
 * matching would silently disable this rather than fail.
 */
const TREE = /(### (?:Page )?Snapshot\s*\n)```yaml\n([\s\S]*?)\n```/;

/** The URL the reply says it is describing. */
const PAGE_URL = /^- Page URL:\s*(\S+)\s*$/m;

/**
 * How many calls back the agent is assumed to still have the earlier reply.
 * Deliberately short. Being wrong in this direction costs a re-read of a page
 * the agent can ask for again; being wrong for a whole session would mean
 * answering "unchanged" about a tree nobody can see any more.
 */
export const MAX_DISTANCE = 12;

export type Remembered = { url: string; tree: string; at: number };

export const treeOf = (body: string): string | undefined => TREE.exec(body)?.[2];

/**
 * The file a reply points at instead of carrying the tree inline.
 *
 * Measured, and it changes what this whole system can see: only
 * `browser_snapshot` returns an inline tree. `browser_navigate` and
 * `browser_click` answer with `- [Snapshot](.playwright-mcp/page-….yml)` and
 * nothing else — 536 bytes with no `[ref=` in them at all.
 *
 * The agent reads that file itself, so it is working from refs the gateway has
 * never seen. Every ref-targeted step after a navigation was therefore
 * unresolvable, and since 80% of flow targets are refs, a session that acted
 * straight off a navigation recorded nothing — not a trajectory, and not the
 * role-and-name anchors in the lesson either.
 */
const SNAPSHOT_FILE = /^\s*-\s*\[Snapshot\]\(([^)\s]+)\)/m;
export const snapshotFileOf = (body: string): string | undefined => SNAPSHOT_FILE.exec(body)?.[1];
export const urlOf = (body: string): string | undefined => PAGE_URL.exec(body)?.[1];

/**
 * The reply with its tree replaced by a statement of what it was, or undefined
 * when this reply is not a repeat and must be sent as it stands.
 */
export function collapseRepeat(
  body: string, previous: Remembered | undefined, call: number,
): string | undefined {
  const tree = treeOf(body);
  const url = urlOf(body);
  if (!tree || !url || !previous || previous.tree !== tree || previous.url !== url)
    return undefined;
  const distance = call - previous.at;
  if (distance > MAX_DISTANCE)
    return undefined;
  // Counted by ref rather than by line: an agent reading this wants to know how
  // much it can still address, and a `- text:` line is not something it can
  // click. Counting lines also overstated it by two thirds.
  const elements = (tree.match(/\[ref=/g) ?? []).length;
  const note =
    `_Unchanged. This page is byte-for-byte the tree you already have — same URL, ` +
    `same ${elements} elements — from ${distance === 1 ? 'the previous call' : `${distance} calls ago`}. ` +
    `Nothing here has moved, and the refs in it are still valid._`;
  // On a small page the explanation costs more than the tree it replaces, and
  // then this is not a saving but a worse answer at a higher price. Measured
  // rather than guarded by a threshold: the two lengths are both right here.
  if (note.length >= tree.length)
    return undefined;
  return body.replace(TREE, (_match, heading: string) => `${heading}${note}`);
}

/**
 * Resolves a snapshot path from a tool reply, or refuses it.
 *
 * The path arrives inside a reply body, and a reply body is not a trusted
 * source of file names. `SNAPSHOT_FILE` matches a markdown link anywhere in it,
 * `.exec` takes the first, and the reply to `browser_evaluate` embeds whatever
 * the page returned — so a hostile page can put `- [Snapshot](…)` in a string,
 * choose the filename, and have it read. The contents then reach the observer
 * as an accessibility tree and can be stored as the targets of a lesson.
 *
 * Two things the obvious version gets wrong, both of which this had:
 *
 *   - `resolved.startsWith(base)` is a prefix test, not a directory boundary.
 *     `<base>-evil/x` passes it. The separator is what makes it a containment
 *     check.
 *   - a symlink inside the directory points wherever it likes, and only
 *     `realpath` sees through it.
 *
 * Returns the absolute path when it is genuinely inside `base`, and a reason
 * when it is not, because a refusal nobody can read is a refusal nobody
 * debugs.
 */
export async function snapshotWithin(
  base: string, link: string, from: string[] = [],
): Promise<{ file: string } | { refused: string }> {
  let root: string;
  try {
    root = await fs.realpath(base);
  } catch {
    return { refused: `the output directory ${base} does not exist` };
  }

  /*
   * The link is relative, and the upstream does not say what to. Observed, it
   * is `<the output directory's own name>/page-….yml`, which resolves against
   * the parent — but that was read off a single install where the output
   * directory sat directly in the working directory, so the two readings
   * cannot be told apart there. Naming the output directory explicitly in the
   * config separates them, and rather than bet on which, both are tried.
   *
   * Trying more bases costs nothing, because the base is not what makes this
   * safe: containment is. A link that resolves outside the output directory is
   * refused no matter which directory it was resolved against, so an extra
   * candidate can only find a file that was always allowed.
   */
  for (const start of [path.dirname(base), ...from]) {
    let resolved: string;
    try {
      resolved = await fs.realpath(path.resolve(start, link));
    } catch {
      continue;
    }
    const inside = path.relative(root, resolved);
    if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside))
      continue;
    return { file: resolved };
  }
  return { refused: 'it is not a readable file inside the output directory' };
}
