/**
 * One JSON document per site, mutated under that site's lock and replaced whole.
 *
 * This is the shape everything the product knows is stored in — lessons,
 * procedures, endpoints, places — and it was implemented four times:
 *
 *     <dir>/<domain>.json     { domain, updated, <collection>: [...] }
 *     <dir>/<domain>.lock     held for the whole read-modify-write
 *
 * Four copies of `_file`, four of `_mutate`, four read-with-ENOENT-default,
 * four write-to-tmp-then-rename, four `readdir` filters. They were not a
 * coincidence: the format is a contract between them. `ApiMap.drift` reads
 * `updated` and parses it as `${updated}T00:00:00Z`, which is only meaningful
 * because the field is a bare `YYYY-MM-DD`.
 *
 * And one of the four had already broken that contract. `PlaceMap` wrote a full
 * ISO timestamp into the same field, so the same string parsed by the same
 * expression would have produced `NaN`. Nothing read it, so nothing failed —
 * which is how a copy drifts: not with a bug, with a difference nobody has a
 * reason to look at.
 *
 * The atomic-replace is not decoration either. A crash between `writeFile` and
 * the end of the buffer truncates a site's entire accumulated knowledge; a
 * crash between `writeFile` to a temporary name and `rename` costs nothing,
 * because `rename` within a filesystem is atomic.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { today } from './dates.ts';
import { withLock } from './lock.ts';

/** What a document holds: its collection, and whatever its owner keeps beside it. */
export type SiteDoc<T> = {
  items: T[];
  /** Every other top-level field — `updated`, and things like `curated`. */
  meta: Record<string, unknown>;
};

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';

export class SiteFile<T> {
  private readonly _dir: string;
  /** The property the collection lives under: `entries`, `procedures`, `endpoints`, `places`. */
  private readonly _key: string;
  /**
   * Distinguishes this file's lock from the other three for the same site.
   * They are separate documents and an agent writing a lesson must not wait on
   * one writing an endpoint.
   */
  private readonly _lockPrefix: string;
  /** How this document is named when it turns out to be corrupt. */
  private readonly _label: string;

  constructor(dir: string, key: string, options: { lockPrefix?: string; label?: string } = {}) {
    this._dir = dir;
    this._key = key;
    this._lockPrefix = options.lockPrefix ?? '';
    this._label = options.label ?? key;
  }

  get dir(): string {
    return this._dir;
  }

  path(domain: string): string {
    return path.join(this._dir, `${domain}.json`);
  }

  /**
   * A missing document is an empty one — a site nobody has visited is not an
   * error. Corruption is: a file that exists and cannot be parsed means
   * something was lost, and silently returning nothing would hide it behind
   * the same answer as a site nobody has been to.
   */
  async read(domain: string): Promise<SiteDoc<T>> {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await fs.readFile(this.path(domain), 'utf8')) as Record<string, unknown>;
    } catch (error) {
      if (isMissing(error))
        return { items: [], meta: {} };
      if (error instanceof SyntaxError)
        throw new Error(`The ${this._label} file for ${domain} is corrupt: ${error.message}`);
      throw error;
    }
    const { [this._key]: items, ...meta } = raw;
    return { items: Array.isArray(items) ? items as T[] : [], meta };
  }

  /** Just the collection, for the many callers that want nothing else. */
  async items(domain: string): Promise<T[]> {
    return (await this.read(domain)).items;
  }

  /**
   * Every read-modify-write goes through here. Without it, two agents recording
   * on the same site at the same moment lose one of the two writes.
   */
  async mutate<R>(domain: string, change: () => Promise<R>): Promise<R> {
    await fs.mkdir(this._dir, { recursive: true });
    return withLock(`${this._lockPrefix}${domain}`, path.join(this._dir, `${domain}.lock`), change);
  }

  /**
   * Replaces the document. An empty collection removes the file rather than
   * leaving an envelope with nothing in it, so "has this site anything" is
   * answered by the directory listing.
   *
   * `updated` is written here and only here, as a bare date, because that is
   * what everything reading it expects.
   */
  async write(domain: string, items: T[], meta: Record<string, unknown> = {}): Promise<void> {
    await fs.mkdir(this._dir, { recursive: true });
    const file = this.path(domain);
    // An empty collection removes the file — unless the document is carrying
    // something else. `curated` is a fact about the site rather than about its
    // lessons, and a domain whose last lesson was forgotten has still been
    // curated. Deleting it with the collection made `markCurated` answer
    // "recorded a curation pass" having recorded nothing, on exactly the
    // domains that hold procedures and no lessons.
    if (!items.length && !Object.keys(meta).length) {
      await fs.rm(file, { force: true });
      return;
    }
    const payload = { domain, updated: today(), ...meta, [this._key]: items };
    // Named for this process. Three of the four copies shared `<file>.tmp` and
    // relied on the lock to keep two writers off it; one did this instead, and
    // it is the one that does not depend on a lock it cannot see.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, file);
  }

  /**
   * Every site with a document here, in one order.
   *
   * Sorted on purpose: `readdir` promises no order, and the procedure list is
   * advertised to the client in the order it comes back. Two sessions holding
   * identical procedures must advertise them identically or every request pays
   * full price for a cache miss on the tool list.
   */
  async domains(): Promise<string[]> {
    const names = await fs.readdir(this._dir).catch(() => [] as string[]);
    return names.filter(name => name.endsWith('.json'))
        .map(name => name.slice(0, -'.json'.length))
        .sort();
  }
}
