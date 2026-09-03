import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireRepoLock,
  acquireRoomLock,
  lockPathFor,
  processAlive,
  withRepoLock,
} from '../../src/engine/lock.js';
import { locksDir, roomLockPath } from '../../src/paths.js';
import { useTempConfigDir } from '../helpers.js';

let config: ReturnType<typeof useTempConfigDir>;

beforeEach(() => {
  config = useTempConfigDir();
});

afterEach(() => {
  config.restore();
});

describe('the per-repo write lock', () => {
  it('serialises two holders in one process', async () => {
    const order: string[] = [];
    const first = await acquireRepoLock('/tmp/repo-a');
    order.push('first in');

    let secondIn = false;
    const second = acquireRepoLock('/tmp/repo-a').then((lock) => {
      secondIn = true;
      order.push('second in');
      return lock;
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(secondIn).toBe(false);

    order.push('first out');
    first.release();
    (await second).release();

    expect(order).toEqual(['first in', 'first out', 'second in']);
  });

  it('does not make rooms on different repos wait for each other', async () => {
    const a = await acquireRepoLock('/tmp/repo-a');
    const b = await acquireRepoLock('/tmp/repo-b');
    a.release();
    b.release();
    expect(true).toBe(true);
  });

  it('writes a lockfile holding this pid, and removes it on release', async () => {
    const path = lockPathFor('/tmp/repo-a');
    const lock = await acquireRepoLock('/tmp/repo-a');
    expect(existsSync(path)).toBe(true);
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it('reclaims a lockfile left behind by a dead process', async () => {
    const path = lockPathFor('/tmp/repo-dead');
    mkdirSync(locksDir(), { recursive: true });
    // A pid that cannot exist, standing in for an `acr` that was SIGKILLed.
    writeFileSync(
      path,
      JSON.stringify({ pid: 2147483646, repoRoot: '/tmp/repo-dead', acquiredAt: 'then' }),
    );

    const lock = await acquireRepoLock('/tmp/repo-dead', { timeoutMs: 2000 });
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it('waits, then gives up, on a lockfile held by a live process', async () => {
    const path = lockPathFor('/tmp/repo-busy');
    mkdirSync(locksDir(), { recursive: true });
    // Our own pid is definitely alive, so this looks like another acr holding the repo.
    writeFileSync(
      path,
      JSON.stringify({ pid: process.pid, repoRoot: '/tmp/repo-busy', acquiredAt: 'now' }),
    );

    let waited: number | undefined;
    await expect(
      acquireRepoLock('/tmp/repo-busy', {
        timeoutMs: 150,
        pollMs: 20,
        onWait: (holder) => {
          waited = holder?.pid;
        },
      }),
    ).rejects.toThrow(/timed out waiting for the write lock/);
    expect(waited).toBe(process.pid);
  });

  it('releases the lock even when the guarded work throws', async () => {
    await expect(
      withRepoLock('/tmp/repo-a', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    // If the lock had leaked, this would hang rather than resolve.
    const again = await acquireRepoLock('/tmp/repo-a', { timeoutMs: 1000 });
    again.release();
  });

  it('knows a live pid from a dead one', () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2147483646)).toBe(false);
    expect(processAlive(0)).toBe(false);
    expect(processAlive(-1)).toBe(false);
  });
});

describe('the cross-process room lock', () => {
  it('refuses a second engine on the same room while the first holds it', async () => {
    mkdirSync(locksDir(), { recursive: true });
    // Our own pid is alive, so this looks exactly like another acr driving the room.
    writeFileSync(
      roomLockPath('room-busy'),
      JSON.stringify({ pid: process.pid, subject: 'room:room-busy', acquiredAt: 'now' }),
    );

    await expect(acquireRoomLock('room-busy', { timeoutMs: 100, pollMs: 20 })).rejects.toThrow(
      /timed out waiting for room room-bus/,
    );
  });

  it('does not make two different rooms wait for each other', async () => {
    const a = await acquireRoomLock('room-a', { timeoutMs: 500 });
    const b = await acquireRoomLock('room-b', { timeoutMs: 500 });
    expect(existsSync(roomLockPath('room-a'))).toBe(true);
    a.release();
    b.release();
    expect(existsSync(roomLockPath('room-a'))).toBe(false);
  });

  it('reclaims a room lock whose holder is gone', async () => {
    mkdirSync(locksDir(), { recursive: true });
    writeFileSync(
      roomLockPath('room-dead'),
      JSON.stringify({ pid: 2147483646, subject: 'room:room-dead', acquiredAt: 'then' }),
    );
    const lock = await acquireRoomLock('room-dead', { timeoutMs: 2000 });
    lock.release();
    expect(existsSync(roomLockPath('room-dead'))).toBe(false);
  });

  it('still reads a lockfile written before the field was renamed', async () => {
    mkdirSync(locksDir(), { recursive: true });
    // Pre-M3 acr wrote `repoRoot`; a stale one of those must not become unreclaimable.
    writeFileSync(
      lockPathFor('/tmp/repo-old'),
      JSON.stringify({ pid: 2147483646, repoRoot: '/tmp/repo-old', acquiredAt: 'then' }),
    );
    const lock = await acquireRepoLock('/tmp/repo-old', { timeoutMs: 2000 });
    lock.release();
    expect(existsSync(lockPathFor('/tmp/repo-old'))).toBe(false);
  });
});
