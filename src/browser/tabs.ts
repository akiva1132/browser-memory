import fs from 'node:fs/promises';
import path from 'node:path';

import { withLock } from '../lib/lock.ts';

/**
 * Closing the tabs we opened, including the ones we never got to close.
 *
 * Each session takes its own tab so that concurrent agents cannot steer each
 * other's page — measured: three agents sharing a tab, one of them navigated
 * and got back somebody else's destination. The cost of that decision is that
 * every session now owes the user a tab back, and a session that is killed
 * rather than asked to stop never pays. After six benchmark runs the browser
 * had four abandoned pages in it, which is the kind of thing that makes someone
 * stop leaving an agent connected to their real browser.
 *
 * Graceful shutdown alone cannot fix this: the whole problem is the exits that
 * are not graceful. So ownership is written down instead. Tabs are identified
 * by their CDP target id — the only identifier here that is stable, since the
 * MCP tab listing offers nothing but an index and indices shift the moment any
 * tab closes — and each is recorded against the pid that opened it. Whoever
 * starts next closes the tabs whose owner is gone.
 *
 * Only ever tabs this system opened. A page the user opened has no entry and is
 * never touched.
 */

type Owned = { target: string; pid: number; session: string; at: string };

const CDP = process.env['BROWSER_CDP_URL'] || 'http://127.0.0.1:9222';
/** Long enough that a hung browser cannot delay a session's first call. */
const TIMEOUT_MS = 2000;

const alive = (pid: number): boolean => {
  try {
    // Signal 0 tests for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function cdp(pathname: string): Promise<unknown> {
  const response = await fetch(`${CDP}${pathname}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class TabRegistry {
  private readonly _file: string;
  private readonly _lock: string;
  private readonly _session: string;
  private _owned: string | undefined;

  constructor(dir: string, session: string) {
    this._file = path.join(dir, 'tabs.json');
    this._lock = path.join(dir, 'tabs.lock');
    this._session = session;
  }

  /**
   * Page target ids, in CDP's order, or undefined when the browser could not be
   * asked.
   *
   * The distinction is load-bearing and used to be lost. An unreachable browser
   * answered with the same empty list as a browser with no pages open, so a
   * failed enumeration became "there were no tabs before" — and then every tab
   * on the machine looked new, `claim` saw more than one candidate and claimed
   * none, and the tab this session had just opened belonged to nobody. Unlike a
   * session that is killed, which leaves a record for the next sweep to act on,
   * that tab has no record and no route back: it stays open forever.
   */
  async targets(): Promise<string[] | undefined> {
    const list = await cdp('/json/list').catch(() => undefined);
    if (!Array.isArray(list))
      return undefined;
    return list
        .filter((item): item is { id: string; type: string } =>
          Boolean(item) && typeof item === 'object' &&
          (item as { type?: string }).type === 'page' &&
          typeof (item as { id?: string }).id === 'string')
        .map(item => item.id);
  }

  private async _read(): Promise<Owned[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this._file, 'utf8')) as { tabs?: Owned[] };
      return Array.isArray(parsed.tabs) ? parsed.tabs : [];
    } catch {
      return [];
    }
  }

  /**
   * Named for this process, like `SiteFile` and for the reason stated there —
   * except that reason is sharper here. This is the one document every gateway
   * on the machine writes to, and it is the document that makes a session
   * survive SIGKILL: lose it and no orphaned tab is ever closed again. A shared
   * `<file>.tmp` had two starting sessions writing the same temporary path and
   * renaming it out from under each other, which is a lost registry rather than
   * a lost write. The lock makes that rare; the name makes it impossible.
   */
  private async _write(tabs: Owned[]): Promise<void> {
    const tmp = `${this._file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify({ tabs }, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, this._file);
  }

  private async _mutate<T>(fn: (tabs: Owned[]) => Promise<[Owned[], T]>): Promise<T> {
    await fs.mkdir(path.dirname(this._file), { recursive: true });
    return withLock('tabs', this._lock, async () => {
      const [next, result] = await fn(await this._read());
      await this._write(next);
      return result;
    });
  }

  /**
   * Whichever page target appeared that was not there before. Identifying the
   * tab this way avoids trusting an index that another session may already have
   * shifted between the call and the answer.
   */
  async claim(before: string[] | undefined): Promise<'claimed' | 'unenumerable' | 'ambiguous'> {
    const now = await this.targets();
    // Nothing can be diffed against a list that was never read, and a diff
    // against a wrong list is worse than none: it makes tabs the user opened
    // look like ours.
    if (!before || !now)
      return 'unenumerable';

    const seen = new Set(before);
    let fresh = now.filter(id => !seen.has(id));
    if (fresh.length > 1) {
      // Two agents opening a tab in the same instant. The other one's is in the
      // registry as soon as it writes, so excluding what is already spoken for
      // usually resolves this — and when it does not, claiming nothing is still
      // the safe answer, because the cost of guessing is closing someone else's
      // page.
      const spoken = new Set((await this._read().catch(() => [] as Owned[])).map(tab => tab.target));
      const unclaimed = fresh.filter(id => !spoken.has(id));
      if (unclaimed.length === 1)
        fresh = unclaimed;
    }
    if (fresh.length !== 1)
      return 'ambiguous';

    this._owned = fresh[0];
    const entry: Owned = {
      target: fresh[0]!,
      pid: process.pid,
      session: this._session,
      at: new Date().toISOString(),
    };
    await this._mutate(async tabs => [[...tabs.filter(tab => tab.target !== entry.target), entry], undefined])
        .catch(() => {});
    return 'claimed';
  }

  /** Drop our claim once the tab has been handed back through the normal path. */
  async release(): Promise<void> {
    const target = this._owned;
    if (!target)
      return;
    this._owned = undefined;
    await this._mutate(async tabs => [tabs.filter(tab => tab.target !== target), undefined]).catch(() => {});
  }

  /**
   * Closes tabs whose owning process is gone. Runs at startup rather than on a
   * timer: the moment a new session begins is both when a stale tab is most
   * likely to exist and when closing one cannot interrupt anybody's work.
   */
  async sweep(): Promise<number> {
    const targets = await this.targets();
    // A browser that cannot be asked has not told us anything, and treating its
    // silence as "no tabs exist" would drop every ownership record on the
    // machine — including the live ones.
    if (!targets)
      return 0;
    const live = new Set(targets);
    const orphans = await this._mutate(async tabs => {
      const dead = tabs.filter(tab => !alive(tab.pid));
      const keep = tabs.filter(tab => alive(tab.pid) && live.has(tab.target));
      return [keep, dead];
    }).catch(() => [] as Owned[]);

    let closed = 0;
    for (const orphan of orphans) {
      if (!live.has(orphan.target))
        continue;
      // A tab we opened, owned by a process that no longer exists.
      await cdp(`/json/close/${orphan.target}`).then(() => { closed += 1; }).catch(() => {});
    }
    return closed;
  }
}
