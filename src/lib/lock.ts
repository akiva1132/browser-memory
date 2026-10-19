import fs from 'node:fs/promises';

/**
 * Every mutation is a read-modify-write of a whole domain file, and each Claude
 * session runs its own gateway process, so two agents recording lessons on the
 * same site at the same moment would silently lose one of them.
 *
 * Two layers guard it: an in-process queue per key so a single gateway never
 * competes with itself, and an exclusive lock file for the cross-process case.
 * `wx` is atomic on every filesystem we care about, which is the whole reason
 * this is a file and not a flag in memory.
 */

const queues = new Map<string, Promise<void>>();

/** Locks older than this are abandoned — a crashed process must not wedge the store. */
const STALE_LOCK_MS = 10_000;
const RETRY_MS = 25;
/**
 * Longer than STALE_LOCK_MS, and that relation is the point rather than either
 * number.
 *
 * Inverted, the two constants make a window in which waiting is guaranteed to
 * be futile: a waiter arriving on a lock left by a process that died 0–5s ago
 * would spin for its whole deadline, watch the lock age reach 10–15s and never
 * pass 15, and then throw. Every mutation on that key failed for about fifteen
 * seconds — and since the callers here mostly `.catch(() => {})`, what that
 * cost was lessons and observations, silently.
 */
const MAX_WAIT_MS = 15_000;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;

let tokens = 0;

/**
 * Returns the token written into the lock file, which is what makes releasing
 * it safe.
 *
 * A lock older than STALE_LOCK_MS is taken from whoever held it. If the
 * original holder then finishes and deletes the path unconditionally, it
 * deletes the *thief's* lock, and a third process walks straight in while two
 * are already inside. Writing an identity and checking it before unlinking
 * turns that into a no-op instead of a silent double-entry.
 */
async function acquire(lockPath: string): Promise<string> {
  const deadline = Date.now() + MAX_WAIT_MS;
  const token = `${process.pid}-${(tokens += 1)}-${Date.now().toString(36)}`;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(`${token} ${new Date().toISOString()}`);
      await handle.close();
      return token;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST')
        throw error;
      const age = await fs.stat(lockPath).then(stat => Date.now() - stat.mtimeMs).catch(() => 0);
      if (age > STALE_LOCK_MS) {
        // Best effort: if another process wins the unlink race, the next
        // iteration simply waits on the lock it created.
        await fs.rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for lock ${lockPath}`);
      await sleep(RETRY_MS);
    }
  }
}

/** Deletes the lock only while it is still ours. */
async function release(lockPath: string, token: string): Promise<void> {
  const held = await fs.readFile(lockPath, 'utf8').catch(() => '');
  if (held.startsWith(token))
    await fs.rm(lockPath, { force: true }).catch(() => {});
}

/**
 * How often a holder says it is still there. Comfortably under the stale
 * threshold, so a single missed tick — a slow disk, a busy event loop — is not
 * mistaken for a death.
 */
const HEARTBEAT_MS = 3_000;

/**
 * Keeps the lock looking alive for as long as its holder is.
 *
 * Without this, "older than ten seconds" means two different things that need
 * opposite treatment: a holder that died, whose lock must be reclaimed or the
 * store wedges forever, and a holder that is merely slow, whose lock must not
 * be — taking it puts two writers inside at once and one update is lost in
 * silence. Age alone cannot tell them apart. A holder that keeps saying so can.
 *
 * That distinction is also what makes the stale threshold safe to keep below
 * the wait deadline: without a heartbeat, shortening it to stop waiters
 * spinning pointlessly would have widened the window for robbing a live holder.
 */
function beat(lockPath: string): () => void {
  const timer = setInterval(() => {
    const now = new Date();
    void fs.utimes(lockPath, now, now).catch(() => {});
  }, HEARTBEAT_MS);
  // Never a reason for the process to stay alive; the work it guards is.
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Runs `fn` with exclusive access for `key`. The in-process chain survives a
 * rejected caller, or one failed write would block the key forever.
 */
export function withLock<T>(key: string, lockPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(async () => {
    const token = await acquire(lockPath);
    const stopBeating = beat(lockPath);
    try {
      return await fn();
    } finally {
      stopBeating();
      await release(lockPath, token);
    }
  });
  queues.set(key, run.then(() => {}, () => {}));
  return run;
}
