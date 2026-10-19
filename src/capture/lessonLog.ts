/**
 * The evidence log, and the moment a piece of evidence becomes a lesson.
 *
 * Promotion is gated on recurrence rather than on a single sighting, because
 * the point of a log that outlives a session is exactly that: something seen
 * twice by two agents is a property of the site, something seen once may be a
 * typo. The count is read back out of the file rather than kept in memory, so a
 * lesson earned by a concurrent agent counts here too.
 *
 * Separated from the Observer because it shares nothing with watching a
 * browser. Its inputs are a candidate and a threshold; its outputs are a line
 * of JSONL and, sometimes, a call to the store. That is the whole of it, and it
 * was 105 lines buried at the bottom of an 840-line class.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { MemoryStore } from '../memory/store.ts';
import { rotate } from '../lib/rotate.ts';
import { silent } from '../lib/trace.ts';
import type { Trace } from '../lib/trace.ts';
import type { LessonInput } from '../types.ts';

/**
 * The ways a lesson can be earned. There were three; `api-shortcut` was a value
 * nothing could produce, left in the union after the detector that used it
 * stopped writing lessons and became proveEndpoint.ts. A type that admits a
 * value the program cannot create tells its reader there is a third path
 * through the code, and there is not.
 *
 * Old observations.jsonl lines still carry the name. They parse and count
 * exactly as before — nothing will ever look their key up again, because
 * nothing produces that key.
 */
export type Detector = 'repair' | 'form-flow';

/** Evidence for one candidate lesson, before it has earned its way into memory. */
type Observation = {
  at: string;
  session: string;
  domain: string;
  detector: Detector;
  /** Stable across sessions. Recurrence is counted on exactly this. */
  signature: string;
};

export type Candidate = LessonInput & { domain: string; detector: Detector; signature: string };

/**
 * How much evidence each kind needs before it is written down.
 *
 * A repair waits for a second sighting: one failure-then-success can be a
 * fumbled argument rather than a property of the site. The sentence that used
 * to open this comment explained the endpoint threshold, which was removed with
 * the detector it belonged to — an endpoint is proved on the API map now, and
 * never passes through here.
 */
export const THRESHOLD: Record<Detector, number> = {
  repair: 2,
  /*
   * Once, and the reasoning for two was a category error.
   *
   * It read: a form filled once may be a one-off errand, so wait for a repeat.
   * That is the right rule for a claim about a site — one sighting may be a
   * coincidence — and the wrong one for a flow, whose evidence is already
   * complete because every call in it ran. Worse, it is self-defeating: real
   * errands are performed once, so requiring a second performance to record the
   * first meant the flow was captured exactly when it had stopped being worth
   * capturing. Measured on the real log: three flows seen, each exactly once,
   * none ever written, and their steps discarded rather than held.
   *
   * The risk this was standing in for is not "is this true" but "will it work
   * again" — answered by running it.
   */
  'form-flow': 1,
};

/**
 * Nothing else in this system bounds growth, and automatic capture is the first
 * thing here that writes without a human in the loop. Past this, the honest
 * answer is consolidation, not more entries.
 */
const MAX_AUTO_PER_DOMAIN = 20;

export class LessonLog {
  private readonly _file: string;
  private readonly _session: string;
  private readonly _store: MemoryStore;
  private readonly _trace: Pick<Trace, 'write'>;

  /** Counted from the file, reloaded whenever it has grown. */
  private _counts: Map<string, number> | undefined;
  private _loadedSize = -1;
  private _healed = false;

  /**
   * Promotions are queued behind this rather than awaited, so writing a lesson
   * never sits in front of the agent's next call. Anything that needs the
   * writes finished — a flush, a test — awaits `settled`.
   */
  private _writing: Promise<void> = Promise.resolve();

  constructor(dir: string, session: string, store: MemoryStore, trace: Pick<Trace, 'write'> = silent) {
    this._file = path.join(dir, 'observations.jsonl');
    this._session = session;
    this._store = store;
    this._trace = trace;
  }

  /** Every queued promotion, finished. */
  settled(): Promise<void> {
    return this._writing.catch(() => {});
  }

  /** Appends the evidence, and promotes it if it has now been seen enough times. */
  async record(candidate: Candidate): Promise<void> {
    const { domain, detector, signature, ...lesson } = candidate;
    const key = `${domain}|${detector}|${signature}`;
    const observation: Observation = {
      at: new Date().toISOString(),
      session: this._session,
      domain,
      detector,
      signature,
    };
    await fs.mkdir(path.dirname(this._file), { recursive: true });
    // Bounded because promotion re-reads this file whenever it grows: every
    // observation costs a full parse, which is fine at hundreds of lines and
    // quadratic at hundreds of thousands.
    await rotate(this._file);
    await this._heal();
    await fs.appendFile(this._file, `${JSON.stringify(observation)}\n`, 'utf8');

    // Everything from here reads a file that is already on disk and writes
    // under a lock, so it is queued rather than awaited.
    this._writing = this._writing.then(() => this._promote(key, detector, domain, lesson))
        .catch(() => {});
  }

  /**
   * A process killed mid-append leaves a line with no newline, and the next
   * append would join two records into one unparseable line.
   */
  private async _heal(): Promise<void> {
    if (this._healed)
      return;
    this._healed = true;
    const handle = await fs.open(this._file, 'r').catch(() => undefined);
    if (!handle)
      return;
    try {
      const { size } = await handle.stat();
      if (!size)
        return;
      const tail = Buffer.alloc(1);
      await handle.read(tail, 0, 1, size - 1);
      if (tail[0] !== 0x0a)
        await fs.appendFile(this._file, '\n', 'utf8');
    } finally {
      await handle.close();
    }
  }

  private async _load(): Promise<Map<string, number>> {
    const size = await fs.stat(this._file).then(stat => stat.size).catch(() => 0);
    // Reloaded when the file has grown, so a lesson learned by a concurrent
    // agent counts towards the threshold here too.
    if (this._counts && size === this._loadedSize)
      return this._counts;
    const counts = new Map<string, number>();
    const raw = await fs.readFile(this._file, 'utf8').catch(() => '');
    for (const line of raw.split('\n')) {
      if (!line.trim())
        continue;
      try {
        const { domain, detector, signature } = JSON.parse(line) as Observation;
        const key = `${domain}|${detector}|${signature}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      } catch {
        // A truncated last line from a killed process is not a reason to
        // discard everything before it.
      }
    }
    this._counts = counts;
    this._loadedSize = size;
    return counts;
  }

  /**
   * Whether the evidence just appended has earned a lesson, and the write if it
   * has. Runs behind `_writing`, never on the agent's call.
   */
  private async _promote(
    key: string, detector: Detector, domain: string, lesson: LessonInput,
  ): Promise<void> {
    // Counted from the log itself: the file is the record that spans sessions,
    // and a separate in-memory tally would drift from it.
    const seen = (await this._load()).get(key) ?? 0;
    if (seen < THRESHOLD[detector]) {
      this._trace.write('observe', detector,
        `Saw "${lesson.title}" on ${domain} ${seen}×; ${detector} needs ` +
        `${THRESHOLD[detector]} before it becomes a lesson.`,
        { domain, detector, seen, threshold: THRESHOLD[detector] });
      return;
    }

    const existing = await this._store.entries(domain).catch(() => []);
    // Retired copies do not count against it. The cap bounds what an agent is
    // handed, and a superseded entry never reaches a brief — charging a slot
    // for one would let a handful of corrections close capture on a domain.
    const auto = existing.filter(entry => entry.by?.startsWith('auto:') && !entry.invalidated).length;
    // Re-recording an entry that already exists is a confirmation, not growth,
    // so the cap only blocks genuinely new ones.
    const isNew = !existing.some(entry => entry.title === lesson.title);
    if (isNew && auto >= MAX_AUTO_PER_DOMAIN) {
      this._trace.write('observe', 'cap',
        `Would have written "${lesson.title}" on ${domain}, but ${auto} auto-lessons ` +
        `is already the cap of ${MAX_AUTO_PER_DOMAIN}.`,
        { domain, detector, auto, cap: MAX_AUTO_PER_DOMAIN });
      return;
    }
    await this._store.remember(domain, lesson);
    this._trace.write('observe', 'learn',
      `${isNew ? 'Wrote' : 'Confirmed'} a ${detector} lesson on ${domain}: "${lesson.title}".`,
      { domain, detector, title: lesson.title, isNew, seen });
  }
}
