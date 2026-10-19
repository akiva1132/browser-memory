import path from 'node:path';

import { SiteFile } from '../lib/siteFile.ts';
import { today } from '../lib/dates.ts';

/**
 * Where the useful parts of a site are, and the URL that lands on each one.
 *
 * The API map answers "what can I read here". This answers the other half of a
 * repeat visit, which is "how do I get to the page at all". On an authenticated
 * app those are different problems: the endpoints are learned free from
 * traffic, but reaching the metrics screen still costs four clicks and four
 * snapshots the second time, exactly as it did the first.
 *
 * Built from where agents actually went, not from a crawl. That choice is worth
 * stating, because a crawl is the obvious design:
 *
 *   - It costs nothing and risks nothing. A crawler loose in a logged-in
 *     dashboard is one mislabelled link away from cancelling a subscription,
 *     and no allowlist of `logout|delete` makes that safe in general.
 *   - Visits are already weighted by what mattered. A crawl finds the help
 *     centre and the cookie policy with the same enthusiasm as the billing
 *     page; agents only ever went to the billing page.
 *   - It composes with what is here. Every navigation is already parsed out of
 *     the response body for domain attribution; the title and path were being
 *     read and thrown away.
 *
 * Recorded on the second distinct session, for the same reason a form flow is:
 * a page visited once during one errand is that errand, and a map of one-off
 * errands is what makes a store stop being worth reading.
 */

export type Place = {
  /** Literal until the evidence says otherwise, then `:id` where it varies. */
  path: string;
  /** The page's own title, which is what makes the map readable. */
  title: string;
  /** Values seen where the path was collapsed, so a template stays concrete. */
  examples?: string[];
  /** Distinct sessions that landed here. Recurrence, not repetition, is the signal. */
  sessions: string[];
  visits: number;
  firstSeen: string;
  lastSeen: string;
};

/** Twice, deliberately: one visit is an errand, two is a destination. */
export const PLACE_THRESHOLD = 2;
/** Kept beside a collapsed segment so `:id` still means something. */
const MAX_EXAMPLES = 3;
/** Longer than this, a path segment is carrying data rather than naming a route. */
const MAX_SEGMENT = 48;
/** Past this, a site is describing its own sprawl rather than its structure. */
const MAX_PLACES = 40;
/** Enough to prove recurrence without keeping a visitor log. */
const MAX_SESSIONS = 4;
/** How many reach a brief. */
const IN_BRIEF = 10;

/**
 * Titles arrive from the page, which means they arrive from whoever wrote the
 * page. Kept to one short line of plain text so a title cannot turn a brief
 * into a place that issues instructions.
 */
const MAX_TITLE = 70;

export function cleanTitle(raw: string): string {
  return raw.replace(/[\r\n]+/g, ' ').replace(/[`*_[\]#|<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

/**
 * A path worth remembering as a destination.
 *
 * The root is where everyone starts and tells the next agent nothing, and a
 * path that is nothing but ids once collapsed is a record detail rather than a
 * section of the site.
 */
export function isDestination(normalized: string): boolean {
  if (normalized === '/' || normalized === '')
    return false;
  const parts = normalized.split('/').filter(Boolean);
  // A route's segments are names, and names are short. Anything longer is one
  // errand's arguments that happen to live in the path — Google Maps encodes a
  // whole search, its coordinates and its place id into path segments, and the
  // first live run duly filed a 300-character blob as a destination.
  if (parts.some(part => part.length > MAX_SEGMENT))
    return false;
  return parts.some(part => part !== VAR);
}

const VAR = ':id';

const segments = (value: string): string[] => value.split('/').filter(Boolean);
const join = (parts: string[]): string => `/${parts.join('/')}`;

/**
 * Where two routes differ, if they differ in exactly one place.
 *
 * This is what decides whether a number in a URL is an identifier or a name,
 * and it is deliberately decided by evidence rather than by shape. Collapsing
 * anything numeric — the obvious rule, and the one this had first — turns
 * MDN's `/HTTP/Status/404` into `/HTTP/Status/:id`, because a rule that looks
 * at one URL cannot tell a record number from the title of a page. Two URLs can:
 * a segment that varies between visits is a variable, and one that never
 * changes is part of the route's name.
 */
function varyingIndex(a: string[], b: string[]): number | undefined {
  if (a.length !== b.length)
    return undefined;
  let found: number | undefined;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i])
      continue;
    if (found !== undefined)
      return undefined;
    found = i;
  }
  return found;
}

/**
 * Whether a segment identifies one record rather than naming a section.
 *
 * Two paths differing in one segment used to be collapsed on that fact alone,
 * which is true of `/servers/12345` and `/servers/98765` and equally true of
 * `/dashboard/websites` and `/dashboard/servers`. The second pair is not one
 * route with a parameter — it is two sections of a dashboard, and collapsing
 * them produced `/dashboard/:id` with whichever title was visited last, then
 * offered it in the brief as somewhere to navigate directly.
 *
 * Getting this wrong in the other direction is cheap: two literal places, both
 * real, both reachable. So the test is deliberately strict, and a segment that
 * reads like a word stays a word.
 */
function looksLikeId(value: string): boolean {
  return /^\d/.test(value) ||            // 12345, 2026-08-03
    /\d{3,}/.test(value) ||              // order-99812
    /^[0-9a-f]{8,}$/i.test(value) ||     // a hex handle
    /^[0-9a-f]{8}-[0-9a-f-]{12,}$/i.test(value) ||
    value.length > 24;                   // longer than anyone names a section
}

/** Whether a literal path is an instance of an already-collapsed route. */
function fitsTemplate(template: string[], candidate: string[]): boolean {
  return template.length === candidate.length &&
    template.every((part, i) => part === VAR || part === candidate[i]);
}

function addExamples(place: Place, values: string[]): void {
  const merged = [...(place.examples ?? [])];
  for (const value of values) {
    if (value && value !== VAR && !merged.includes(value))
      merged.push(value);
  }
  place.examples = merged.slice(0, MAX_EXAMPLES);
}

export class PlaceMap {
  private readonly _file: SiteFile<Place>;
  private readonly _session: string;
  /** Pending visits per domain, flushed on a domain change and at session end. */
  private readonly _pending = new Map<string, Map<string, string>>();

  constructor(dir: string, session: string) {
    this._file = new SiteFile<Place>(
        path.join(dir, 'places'), 'places', { lockPrefix: 'places:', label: 'place map' });
    this._session = session;
  }

  /**
   * Buffered rather than written through: a navigation happens on the hot path
   * of every tool call, and a lock acquired there would put file I/O between
   * the agent and its answer for no benefit — nothing reads this map until the
   * next session.
   */
  saw(domain: string, rawPath: string, title: string): void {
    if (!domain || !title)
      return;
    const literal = join(segments(rawPath || '/'));
    if (!isDestination(literal))
      return;
    const byPath = this._pending.get(domain) ?? new Map<string, string>();
    // Last title wins: a page that renames itself once loaded should be
    // remembered by the name it settles on.
    byPath.set(literal, cleanTitle(title));
    this._pending.set(domain, byPath);
  }

  /**
   * `undefined` is "everything", which is the shutdown case. A domain named but
   * empty is a different request and must not collapse into it: on the first
   * navigation of a session there is no previous site, and treating that as
   * "everything" flushed the page the agent had just landed on — through a
   * lock, on the hot path, which is the one thing the buffer above exists to
   * avoid.
   */
  async flush(domain?: string): Promise<void> {
    const domains = domain === undefined ? [...this._pending.keys()] : domain ? [domain] : [];
    for (const name of domains) {
      const pending = this._pending.get(name);
      this._pending.delete(name);
      if (pending?.size)
        await this._merge(name, pending).catch(() => {});
    }
  }

  private async _merge(domain: string, pending: Map<string, string>): Promise<void> {
    await this._file.mutate(domain, async () => {
      const places = await this.all(domain);
      for (const [literal, title] of pending)
        this._absorb(places, literal, title);
      // Trimmed by how many separate sessions needed the page, then by how
      // recently — a place four sessions used beats one that was hit twice in
      // an afternoon and never again.
      const kept = places
          .sort((a, b) => b.sessions.length - a.sessions.length || b.lastSeen.localeCompare(a.lastSeen))
          .slice(0, MAX_PLACES);
      await this._file.write(domain, kept);
    });
  }

  /**
   * Files one visit into the list, collapsing a route the moment a second
   * value shows up in the same position. Mutates `places` in place.
   */
  private _absorb(places: Place[], literal: string, title: string): void {
    const parts = segments(literal);
    const touch = (place: Place): void => {
      place.title = title;
      place.visits += 1;
      place.lastSeen = today();
      if (!place.sessions.includes(this._session))
        place.sessions = [...place.sessions, this._session].slice(-MAX_SESSIONS);
    };

    const exact = places.find(place => place.path === literal);
    if (exact) {
      touch(exact);
      return;
    }

    // Already collapsed here on earlier evidence: this visit is one more
    // instance, and its own value is worth keeping as an example.
    const template = places.find(place => place.path.includes(VAR) && fitsTemplate(segments(place.path), parts));
    if (template) {
      const shape = segments(template.path);
      addExamples(template, parts.filter((_, i) => shape[i] === VAR));
      touch(template);
      return;
    }

    // Two literals that differ in exactly one segment are one route. The
    // sessions of both count towards it: the whole reason to collapse is that
    // two separate visits were to the same place.
    for (const place of places) {
      const shape = segments(place.path);
      const index = varyingIndex(shape, parts);
      if (index === undefined || shape[index] === VAR)
        continue;
      // Differing in one segment is not enough on its own — sibling sections of
      // a dashboard differ in exactly one segment too, and they are two places
      // rather than one route.
      if (!looksLikeId(shape[index]!) || !looksLikeId(parts[index]!))
        continue;
      const collapsed = [...shape];
      collapsed[index] = VAR;
      if (!isDestination(join(collapsed)))
        continue;
      addExamples(place, [shape[index]!, parts[index]!]);
      place.path = join(collapsed);
      touch(place);
      return;
    }

    places.push({
      path: literal, title, sessions: [this._session],
      visits: 1, firstSeen: today(), lastSeen: today(),
    });
  }

  async all(domain: string): Promise<Place[]> {
    return this._file.items(domain);
  }

  /** Only what has earned its place: seen by more than one session. */
  async established(domain: string): Promise<Place[]> {
    return (await this.all(domain)).filter(place => place.sessions.length >= PLACE_THRESHOLD);
  }
}

export function renderPlaces(domain: string, places: Place[], limit = IN_BRIEF): string {
  if (!places.length)
    return '';
  const shown = places.slice(0, limit);
  const rest = places.length - shown.length;
  const lines = shown.map(place => {
    // A template with no example is a riddle; one example makes it obvious
    // whether `:id` means a server number or a status code.
    const examples = place.examples?.length ? ` _(e.g. ${place.examples.join(', ')})_` : '';
    return `- \`${place.path}\` — ${place.title}${examples}`;
  });
  const templated = shown.some(place => place.path.includes(':id'));
  return `**Places on ${domain}** — earlier agents reached these; navigate straight there ` +
    `instead of clicking through.\n\n${lines.join('\n')}` +
    `${rest > 0 ? `\n\n_…and ${rest} more._` : ''}` +
    `${templated ? `\n\n_\`:id\` is a placeholder — substitute the one you need._` : ''}`;
}
