/**
 * The two date expressions this program uses, written once.
 *
 * `today()` was the same one-liner in four files and `daysSince()` in two. They
 * agreed, which is the only reason nothing was ever wrong — five copies of a
 * definition are five chances for one of them to start meaning something
 * slightly different, and the one that drifts is the one nobody reads again.
 *
 * Both are UTC on purpose. Every date stored here is a bare `YYYY-MM-DD` shared
 * between sessions and machines, and a local-time reading of that is off by a
 * day for anyone east or west of whoever wrote it.
 */

/** The stored form of a date: `YYYY-MM-DD`, UTC. */
export const today = (): string => new Date().toISOString().slice(0, 10);

/** Whole days between a stored date and now. Negative if the date is ahead. */
export const daysSince = (date: string): number =>
  Math.floor((Date.now() - Date.parse(`${date}T00:00:00Z`)) / 86400000);
