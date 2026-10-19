import fs from 'node:fs';
import fsp from 'node:fs/promises';

/**
 * Keeps the append-only logs from growing without limit.
 *
 * Both of them are written on every tool call and neither had any bound. The
 * audit log is the one account of a session that the agent cannot edit, so it
 * is never truncated in place — it is rolled to `.1`, and the previous `.1` is
 * dropped. One generation is the deliberate compromise: enough to investigate
 * something that happened recently, bounded enough that nobody has to think
 * about disk.
 *
 * The observation log has a second reason to stay small. Promotion re-reads it
 * whenever it grows, so every observation costs a full parse of the file — fine
 * at a few hundred lines, quadratic by the time it reaches a hundred thousand.
 */

/** Rolls at this size. Roughly a week of heavy use at ~200 bytes a line. */
export const MAX_LOG_BYTES = 4 * 1024 * 1024;

/*
 * Both of these roll with a bare rename, and the missing unlink is deliberate.
 *
 * The memory directory is shared by every gateway on the machine, so two of
 * them can reach the size threshold at the same moment. `rm` then `rename` is
 * two steps with a gap in the middle: the second process can delete the
 * generation the first has just written, and a whole generation of the one
 * account of a session the agent cannot edit disappears. `rename` on POSIX
 * replaces the destination atomically and needs no unlink, so the same race
 * ends with one winner and one harmless ENOENT.
 */

/** Synchronous, for the audit log: it is written synchronously so a crash cannot lose it. */
export function rotateSync(file: string, max = MAX_LOG_BYTES): void {
  try {
    if (fs.statSync(file).size < max)
      return;
    fs.renameSync(file, `${file}.1`);
  } catch {
    // A log that cannot be rotated is not a reason to fail the call that was
    // being logged.
  }
}

export async function rotate(file: string, max = MAX_LOG_BYTES): Promise<void> {
  try {
    const { size } = await fsp.stat(file);
    if (size < max)
      return;
    await fsp.rename(file, `${file}.1`);
  } catch {
    // Same reasoning.
  }
}

/**
 * Deletes files in a directory older than `days`. Used for the upstream's
 * output directory, which accumulates a page snapshot and two console logs per
 * session and is never cleaned by anything else — 490 files after a week here.
 */
export async function prune(dir: string, days: number): Promise<number> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const full = `${dir}/${name}`;
    const stat = await fsp.stat(full).catch(() => undefined);
    if (!stat?.isFile() || stat.mtimeMs >= cutoff)
      continue;
    await fsp.rm(full, { force: true }).then(() => { removed += 1; }).catch(() => {});
  }
  return removed;
}
