/**
 * Lessons are written by an agent that has just been inside an authenticated
 * session, and they are read by every agent that follows. A cookie or bearer
 * token copied into a snippet would be persisted to disk and handed out
 * forever, so everything is filtered on the way in.
 *
 * Redaction is deliberately eager. A false positive costs a lesson one
 * unreadable value the next agent can re-derive; a false negative leaks a live
 * credential.
 */

/**
 * Rules that recognise a secret by its own shape. Safe on code, because nothing
 * that looks like this is ever an expression somebody meant to write.
 */
const LITERAL_RULES: readonly (readonly [RegExp, string])[] = [
  // Authorization / bearer tokens, including the header form.
  [/\b(authorization\s*[:=]\s*)(['"]?)(bearer|basic|token)\s+[\w.\-+/=]{8,}\2/gi, '$1$2$3 «redacted»$2'],
  [/\bbearer\s+[\w.\-+/=]{20,}/gi, 'bearer «redacted»'],
  // JWTs are unmistakable and frequently pasted whole.
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '«redacted:jwt»'],
  // Cookie headers and document.cookie assignments.
  [/\b(set-cookie|cookie)\s*[:=]\s*(['"]?)[^'"\n]{16,}\2/gi, '$1: «redacted:cookie»'],
  [/\bdocument\.cookie\s*=\s*(['"`])[^'"`]{8,}\1/gi, 'document.cookie = «redacted:cookie»'],
  // Vendor-shaped keys, recognizable on their own.
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}/g, '«redacted:key»'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '«redacted:key»'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '«redacted:key»'],
  [/\bAIza[\w-]{20,}/g, '«redacted:key»'],
  [/\bxox[baprs]-[\w-]{10,}/g, '«redacted:key»'],
  // Long opaque blobs: no meaning to a reader, plenty to an attacker.
  [/\b[A-Fa-f0-9]{48,}\b/g, '«redacted:blob»'],
];

/**
 * `something_token = <value>` in prose is a pasted credential. In code the
 * right-hand side is an expression, and rewriting it produces syntax:
 *
 *   const apiKey = params.key;   →   const apiKey = «redacted»;
 *   const csrf = document.querySelector("meta[name=csrf]").content;
 *                                →   const csrf = «redacted»"meta[name=csrf]").content;
 *
 * That is the exact shape of "call the site's own API", which is the most
 * valuable thing anyone can save here — so on code this rule is a detector that
 * refuses, never a rewriter.
 */
const SECRET_NAME =
  '[\\w-]*(?:api[_-]?key|apikey|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|' +
  'private[_-]?key|client[_-]?secret|session[_-]?id|csrf[_-]?token|auth[_-]?token)';

const NAMED_SECRET = new RegExp(`\\b(${SECRET_NAME})\\b(\\s*[:=]\\s*)(['"]?)[^\\s,;'"&)}\\]]{6,}\\3`, 'gi');

/**
 * The same name, but assigned a quoted string. `apiKey = "sk-abc123"` is a
 * pasted credential in any language; `apiKey = params.key` is a variable. The
 * quote is what separates them, and rewriting only the quoted form leaves
 * working code working.
 */
const NAMED_SECRET_LITERAL =
  new RegExp(`\\b(${SECRET_NAME})\\b(\\s*[:=]\\s*)(['"\`])[^'"\`\\n]{6,}\\3`, 'gi');

/**
 * Everything that is safe to rewrite inside source code. Once quoted
 * assignments are covered, what remains matching the broad rule is an
 * expression — `apiKey = params.key` — and refusing those would reject almost
 * every real procedure, which is the same failure as mangling them.
 */
const CODE_RULES: readonly (readonly [RegExp, string])[] = [
  ...LITERAL_RULES,
  [NAMED_SECRET_LITERAL, '$1$2$3«redacted»$3'],
];

const RULES: readonly (readonly [RegExp, string])[] = [
  ...LITERAL_RULES,
  [NAMED_SECRET, '$1$2$3«redacted»$3'],
];

/** Prose fields, where a `name = value` match really is a pasted credential. */
const FIELDS = ['title', 'gist', 'body', 'trigger'] as const;

export function redactText(value: string): { text: string; hits: number };
export function redactText(value: undefined): { text: undefined; hits: number };
export function redactText(value: string | undefined): { text: string | undefined; hits: number };
export function redactText(value: string | undefined): { text: string | undefined; hits: number } {
  if (typeof value !== 'string' || !value)
    return { text: value, hits: 0 };
  let text = value;
  let hits = 0;
  for (const [pattern, replacement] of RULES) {
    // Count first, then replace: doing both in one pass would mean expanding
    // $1/$2 by hand, which is exactly where a redaction bug would hide.
    const found = text.match(pattern);
    if (!found)
      continue;
    hits += found.length;
    text = text.replace(pattern, replacement);
  }
  return { text, hits };
}

/**
 * Code is checked, not rewritten.
 *
 * Only shape-recognisable literals are stripped — a JWT or an `sk_live_` key
 * pasted into a snippet is a credential wherever it appears. A named-secret
 * assignment is instead reported, so the caller can refuse the whole thing: a
 * procedure is executable, and half-redacted executable code is worse than
 * either keeping it or rejecting it. Returning the offending names lets the
 * refusal say what to change.
 */
export function redactCode(value: string): { text: string; hits: number } {
  let text = value;
  let hits = 0;
  for (const [pattern, replacement] of CODE_RULES) {
    const found = text.match(pattern);
    if (!found)
      continue;
    hits += found.length;
    text = text.replace(pattern, replacement);
  }
  return { text, hits };
}

/**
 * Returns a copy with credentials stripped, plus how many values were removed,
 * so the caller can tell the agent rather than silently mangling what it wrote.
 */
export function redactEntry<T extends Record<string, unknown>>(fields: T): { fields: T; redacted: number } {
  const out: Record<string, unknown> = { ...fields };
  let hits = 0;
  for (const field of FIELDS) {
    const value = out[field];
    if (typeof value !== 'string')
      continue;
    const result = redactText(value);
    out[field] = result.text;
    hits += result.hits;
  }
  // A snippet is code the next agent will copy and run. Prose rules turn
  // `const key = params.key` into `const key = «redacted»` — a snippet that
  // no longer parses, offered as the fast path.
  if (typeof out['snippet'] === 'string') {
    const result = redactCode(out['snippet']);
    out['snippet'] = result.text;
    hits += result.hits;
  }
  if (Array.isArray(out['tags']))
    out['tags'] = (out['tags'] as string[]).map(tag => redactText(tag).text);
  return { fields: out as T, redacted: hits };
}
