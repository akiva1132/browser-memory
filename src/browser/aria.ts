/**
 * Reading the accessibility tree the browser prints, in one place.
 *
 * Three copies of this parser had grown: the observer's, for turning a ref into
 * a durable anchor at capture time; the anchors probe's, for measuring whether
 * those anchors survive; and replay's, for finding an element again when one
 * does not. They have to agree — a healer that parses names differently from
 * the recorder will conclude the element is gone when it is looking straight at
 * it. That is the same class of bug as the two `normalizePath` copies, which
 * turned a contradiction check into "every endpoint is imaginary".
 */

/** Role and accessible name, as the browser computed them. */
export type Anchor = { role: string; name: string };

/**
 * One node, as the browser prints it:
 *
 *   - textbox "Subject" [active] [ref=f10e492]
 *
 * Role first, then the accessible name JSON-quoted when the node has one, then
 * attributes.
 */
export const SNAPSHOT_NODE = /^\s*-\s+([a-zA-Z]+)(\s+"(?:[^"\\]|\\.)*")?((?:\s*\[[^\]\n]*\])+)?/;
export const REF_ATTR = /\[ref=((?:f\d+)?e\d+)\]/;

/**
 * Names past this length are page content that happens to be labelling
 * something, not a label. They are also matched whole, so storing one is
 * storing an anchor that will not match.
 */
export const MAX_NAME = 120;

/** The name as written on one node, or '' when it has none or it will not parse. */
export function nameOf(node: RegExpExecArray): string {
  try {
    return node[2] ? String(JSON.parse(node[2].trim())) : '';
  } catch {
    // A name the browser quoted and we cannot parse leaves the role, which on
    // its own is not an anchor — the node is simply not resolvable.
    return '';
  }
}

/**
 * The pair, written the way the browser accepts it straight back as a `target`
 * — so a stored step is replayed rather than translated.
 *
 * A role with no name is not an anchor: `role=textbox` matches every text box on
 * the page, and an anchor that resolves to the wrong element is worse than none.
 */
export function anchorOf(node: Anchor | undefined): string | undefined {
  const name = node?.name.replace(/\s+/g, ' ').trim() ?? '';
  if (!node?.role || !name || name.length > MAX_NAME)
    return undefined;
  return `role=${node.role}[name=${JSON.stringify(name)}]`;
}

/** Splits `role=button[name="Send"]` back into its parts. */
export function parseAnchor(target: string): Anchor | undefined {
  const match = /^role=([a-zA-Z]+)\[name=("(?:[^"\\]|\\.)*")\]$/.exec(target.trim());
  if (!match)
    return undefined;
  try {
    return { role: match[1]!, name: String(JSON.parse(match[2]!)) };
  } catch {
    return undefined;
  }
}

/**
 * Every named, interactive node in a snapshot.
 *
 * Duplicates are kept rather than collapsed: whether a name occurs once is the
 * whole question when an anchor has to be resolved again, and a caller that
 * cannot see the second occurrence will act on the first.
 */
export function anchorsIn(snapshot: string): Anchor[] {
  const found: Anchor[] = [];
  for (const line of snapshot.split('\n')) {
    const node = SNAPSHOT_NODE.exec(line);
    if (!node)
      continue;
    const name = nameOf(node);
    if (name)
      found.push({ role: node[1] ?? '', name });
  }
  return found;
}

/**
 * A name reduced to what a person would call the same.
 *
 * The bidirectional control characters are the reason this exists rather than a
 * lowercase call. Gmail's send button is `שליחה ‪(Ctrl-Enter)‬` — the label
 * carries U+202A/U+202C around the shortcut, invisible everywhere they are
 * displayed and decisive in a string comparison. An anchor recorded from that
 * page and compared literally against the same page fails, which is a healer
 * declaring an element gone while looking directly at it.
 */
export function normalizeName(name: string): string {
  return name
      .replace(/[‎‏‪-‮⁦-⁩­]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
}
