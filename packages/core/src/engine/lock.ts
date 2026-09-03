import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { locksDir } from '../paths.js';

/**
 * The per-repo write lock from PLAN.md section 3 ("two agents editing at once").
 *
 * Two layers, because there are two ways it can go wrong:
 *
 *  - an in-process queue, so two rooms opened on one repo inside a single `acr` serialise
 *    their writing turns instead of racing;
 *  - an advisory lockfile carrying a pid, so a second `acr` process cannot interleave with
 *    the first. It is best effort by nature: a SIGKILLed `acr` leaves the file behind, and
 *    the pid check is what reclaims it.
 *
 * Rooms on *different* repos never contend. That is intended – the lock exists to protect
 * a working tree, not to rate-limit the machine.
 */

export interface LockHandle {
  /** Safe to call more than once. */
  release(): void;
}

export interface AcquireLockOptions {
  /** Give up after this long. Default: wait forever, because a turn legitimately takes minutes. */
  timeoutMs?: number;
  /** How often to re-check a lockfile held by a live process. */
  pollMs?: number;
  /** Called once if the lock is not immediately available, so callers can say why they wait. */
  onWait?: (holder: LockFileContents | undefined) => void;
}

export interface LockFileContents {
  pid: number;
  repoRoot: string;
  acquiredAt: string;
}

/** One chained promise per repo. Awaiting it is the in-process queue. */
const queues = new Map<string, { tail: Promise<void>; waiters: number }>();

export function lockPathFor(repoRoot: string): string {
  const hash = createHash('sha1').update(repoRoot).digest('hex').slice(0, 16);
  return join(locksDir(), `${hash}.lock`);
}

/**
 * Acquire the write lock for `repoRoot`. Resolves once this caller owns it; the caller
 * must `release()` in a `finally`.
 */
export async function acquireRepoLock(
  repoRoot: string,
  opts: AcquireLockOptions = {},
): Promise<LockHandle> {
  const entry = queues.get(repoRoot) ?? { tail: Promise.resolve(), waiters: 0 };
  const previous = entry.tail;
  let releaseQueue!: () => void;
  const mine = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  entry.tail = previous.then(() => mine);
  entry.waiters += 1;
  queues.set(repoRoot, entry);

  await previous;

  let released = false;
  const releaseInProcess = (): void => {
    if (released) return;
    released = true;
    releaseQueue();
    entry.waiters -= 1;
    // Forget an idle repo, so a long-lived process does not keep a chain of resolved
    // promises alive for every repo it has ever touched.
    if (entry.waiters === 0 && queues.get(repoRoot) === entry) queues.delete(repoRoot);
  };

  let file: LockFileRelease | undefined;
  try {
    file = await acquireLockFile(repoRoot, opts);
  } catch (err) {
    releaseInProcess();
    throw err;
  }

  return {
    release(): void {
      file?.release();
      releaseInProcess();
    },
  };
}

/** Run `fn` while holding the repo's write lock. */
export async function withRepoLock<T>(
  repoRoot: string,
  fn: () => Promise<T>,
  opts: AcquireLockOptions = {},
): Promise<T> {
  const lock = await acquireRepoLock(repoRoot, opts);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

interface LockFileRelease {
  release(): void;
}

async function acquireLockFile(
  repoRoot: string,
  opts: AcquireLockOptions,
): Promise<LockFileRelease> {
  const path = lockPathFor(repoRoot);
  const pollMs = opts.pollMs ?? 250;
  const deadline = opts.timeoutMs === undefined ? undefined : Date.now() + opts.timeoutMs;
  let announced = false;

  for (;;) {
    try {
      mkdirSync(locksDir(), { recursive: true });
      // 'wx' fails when the file exists, which is the whole atomicity guarantee.
      const fd = openSync(path, 'wx');
      const contents: LockFileContents = {
        pid: process.pid,
        repoRoot,
        acquiredAt: new Date().toISOString(),
      };
      writeSync(fd, JSON.stringify(contents));
      closeSync(fd);
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          rmSync(path, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        // Cannot create the lockfile at all (read-only home, no permissions). The
        // in-process queue still holds; refusing to run would be worse than proceeding.
        return { release: () => undefined };
      }
    }

    const holder = readLockFile(path);
    if (!holder || !processAlive(holder.pid)) {
      // Stale: the process that wrote it is gone. Reclaim and try again.
      rmSync(path, { force: true });
      continue;
    }

    if (!announced) {
      announced = true;
      opts.onWait?.(holder);
    }
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for the write lock on ${repoRoot} (held by pid ${holder.pid} since ${holder.acquiredAt})`,
      );
    }
    await sleep(pollMs);
  }
}

export function readLockFile(path: string): LockFileContents | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockFileContents>;
    if (typeof parsed.pid !== 'number') return undefined;
    return {
      pid: parsed.pid,
      repoRoot: String(parsed.repoRoot ?? ''),
      acquiredAt: String(parsed.acquiredAt ?? ''),
    };
  } catch {
    return undefined;
  }
}

/** `kill(pid, 0)` is the portable "does this process exist" probe; it sends no signal. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else, which still counts as held.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
