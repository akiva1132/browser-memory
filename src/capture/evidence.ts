/**
 * Reading a tool reply for the parts that are evidence.
 *
 * Every detector in the recorder asks the same two questions of a reply — what
 * did the call actually return, and what does this failure have in common with
 * the last one — and both are pure functions of a string. They lived at the top
 * of observe.ts among the class's own constants, where nothing could import
 * them and the only way to exercise them was to drive the whole Observer.
 *
 * Nothing here knows about a store, a session or a browser.
 */
import { normalizePath } from './apiMap.ts';

/** Below this, `browser_evaluate` returned a bare value rather than a payload. */
export const MIN_PAYLOAD_CHARS = 40;

/**
 * Sections of a reply that are not what the call returned. The browser echoes
 * the code it ran, and most replies carry the tab list and page block too.
 */
const NOT_PAYLOAD = new Set(['Ran Playwright code', 'Open tabs', 'Page', 'Snapshot', 'Page Snapshot']);

/**
 * What the call actually returned, with the browser's own commentary removed.
 *
 * Measuring the whole reply was how a `browser_evaluate` returning `null`
 * became a lesson claiming the endpoint "returns data directly". The reply is
 * 120 characters — comfortably past the payload threshold — because the browser
 * echoes the source of the function underneath the result:
 *
 *   ### Result
 *   null
 *   ### Ran Playwright code
 *   ```js
 *   await page.evaluate('async () => { await fetch("/"); return null; }');
 *   ```
 *
 * The padding is the fetch call itself, so the guard was defeated in exact
 * proportion to how much the detector wanted to fire — an elaborate snippet
 * that returned nothing sailed through, and `describePayload` then measured the
 * echo and reported its shape as the response's.
 */
export function payloadOf(body: string): string {
  const sections = new Map<string, string>();
  const pattern = /^### (.+)$/gm;
  let match: RegExpExecArray | null;
  let previous: { heading: string; from: number } | undefined;
  while ((match = pattern.exec(body))) {
    if (previous)
      sections.set(previous.heading, body.slice(previous.from, match.index));
    previous = { heading: match[1]!.trim(), from: match.index + match[0].length };
  }
  if (previous)
    sections.set(previous.heading, body.slice(previous.from));
  // A reply with no headings at all is its own payload; anything else is read
  // by name, so a section being renamed loses this detector rather than
  // silently feeding it commentary.
  if (!sections.size)
    return body.trim();
  const result = sections.get('Result');
  if (result !== undefined)
    return result.trim();
  return [...sections].filter(([heading]) => !NOT_PAYLOAD.has(heading))
      .map(([, content]) => content.trim()).join('\n').trim();
}

export const FETCH_CALL = /\bfetch\s*\(\s*[`'"]([^`'"]+)[`'"]/;
export const XHR_OPEN = /\.open\s*\(\s*[`'"](\w+)[`'"]\s*,\s*[`'"]([^`'"]+)[`'"]/;
export const METHOD_OPTION = /\bmethod\s*:\s*[`'"](\w+)[`'"]/;

export const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}…` : value;

/*
 * The path normalizer is the API map's, not a third copy.
 *
 * There were three, and they disagreed: this one left `{id}` and a bare `:id`
 * alone and did not recognise a long hex handle. The same endpoint therefore
 * arrived under one spelling in a captured lesson and another in the map, so
 * nothing downstream could tell they were the same route — which is precisely
 * what the curation pass, the drift check and the draft generator all have to
 * decide. Ids, dates and interpolations collapse so that the same endpoint hit
 * with different arguments counts as one observation; without that every call
 * is unique and recurrence never fires.
 */

/** What the query string is called matters; what is in it is per-call noise. */
export function endpointOf(raw: string): { path: string; query: string[] } {
  const [before, after = ''] = raw.split('?');
  const query = after
      .split('&')
      .map(pair => pair.split('=')[0] ?? '')
      .filter(Boolean);
  return { path: normalizePath(before ?? raw), query };
}

/** Enough to say what came back without copying the user's data into memory. */
export function describePayload(body: string): string {
  const trimmed = body.trim();
  if (/^\[/.test(trimmed) || /"\w+"\s*:\s*\[/.test(trimmed))
    return `a JSON payload (~${trimmed.length} chars, contains arrays)`;
  if (/^\{/.test(trimmed) || /"\w+"\s*:/.test(trimmed))
    return `a JSON object (~${trimmed.length} chars)`;
  return `~${trimmed.length} chars of data`;
}

/** Strips the per-call detail so the same failure recurs under the same name. */
export function errorFingerprint(body: string): string {
  return clip(body, 200)
      .replace(/[`'"][^`'"]*[`'"]/g, '…')
      .replace(/\d+/g, 'N')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
}

export function changedKeys(
  before: Record<string, unknown>, after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}
