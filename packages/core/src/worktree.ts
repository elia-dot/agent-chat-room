import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

import * as git from './git.js';
import { diffPath, roomWorktreePath, turnLogPath } from './paths.js';
import type { RoomStore } from './store/rooms.js';
import type { Room } from './store/types.js';

/**
 * Every room runs in its own git worktree (PLAN.md section 7, decided 2026-09-03).
 *
 * Two things fall out of that and both matter: the human's checkout is never touched, so
 * `acr` no longer has to refuse a dirty tree, and the room's diff is attributable to the
 * room by construction rather than by asking the human to tidy up first.
 */

const MAX_SLUG_LENGTH = 40;

/** `Fix the flaky login test` -> `fix-the-flaky-login-test`. */
export function slugify(title: string, fallback = 'room'): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-$/, '');
  return slug || fallback;
}

/**
 * A slug whose branch `acr/<slug>` does not exist yet. Two rooms with the same task text
 * is an ordinary thing to do, so collisions get a short suffix instead of an error.
 */
export async function uniqueSlug(
  repoRoot: string,
  title: string,
  suffix?: string,
): Promise<string> {
  const base = slugify(title);
  if (!(await git.branchExists(repoRoot, branchFor(base)))) return base;

  const tail = (suffix ?? Math.random().toString(36).slice(2))
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 6);
  const candidate = `${base.slice(0, MAX_SLUG_LENGTH - tail.length - 1)}-${tail}`;
  if (!(await git.branchExists(repoRoot, branchFor(candidate)))) return candidate;

  // Two collisions in a row means something is systematically wrong; fall back to a
  // timestamp rather than looping.
  return `${base.slice(0, 24)}-${Date.now().toString(36)}`;
}

export function branchFor(slug: string): string {
  return `acr/${slug}`;
}

export interface Worktree {
  path: string;
  branch: string;
  /** HEAD the worktree was created from. Every diff in the room is taken against this. */
  baseSha?: string;
}

export interface CreateWorktreeOptions {
  repoRoot: string;
  roomId: string;
  branch: string;
  /** Commit-ish the room branch starts from. Defaults to the checkout's current HEAD. */
  startPoint?: string;
}

export async function createWorktree(opts: CreateWorktreeOptions): Promise<Worktree> {
  const path = roomWorktreePath(opts.roomId);
  mkdirSync(dirname(path), { recursive: true });
  // `git worktree add` insists on creating the directory itself.
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  await git.worktreePrune(opts.repoRoot);

  const startPoint = opts.startPoint ?? (await git.headSha(opts.repoRoot));
  await git.worktreeAdd(opts.repoRoot, path, opts.branch, {
    createBranch: true,
    ...(startPoint ? { startPoint } : {}),
  });
  const baseSha = await git.headSha(path);
  return { path, branch: opts.branch, ...(baseSha ? { baseSha } : {}) };
}

/**
 * Re-attach a room to its worktree after a restart. The directory may be gone – someone
 * cleaned `~/.config` – in which case the branch is still there and can be checked out
 * again, which is the whole reason the engine commits to a branch rather than a directory.
 */
export async function ensureWorktree(opts: {
  repoRoot: string;
  path: string;
  branch: string;
}): Promise<Worktree> {
  if (existsSync(opts.path)) return { path: opts.path, branch: opts.branch };
  await git.worktreePrune(opts.repoRoot);
  mkdirSync(dirname(opts.path), { recursive: true });
  const exists = await git.branchExists(opts.repoRoot, opts.branch);
  await git.worktreeAdd(opts.repoRoot, opts.path, opts.branch, { createBranch: !exists });
  return { path: opts.path, branch: opts.branch };
}

export async function removeWorktree(repoRoot: string, path: string): Promise<void> {
  await git.worktreeRemove(repoRoot, path);
  // `git worktree remove` refuses in a few situations (a nested repo, a busy file). The
  // room is being closed either way, so make sure the directory really goes.
  rmSync(path, { recursive: true, force: true });
  await git.worktreePrune(repoRoot);
}

/**
 * Purge all data associated with a room: worktree directory, overflow diffs, turn logs,
 * and SQLite rows.
 */
export async function purgeRoomData(
  room: Room,
  store: RoomStore,
): Promise<{ worktreeRemoved: boolean; diffsRemoved: number; turnsRemoved: number }> {
  let worktreeRemoved = false;
  const wtPath = room.worktreePath || roomWorktreePath(room.id);
  if (existsSync(wtPath)) {
    try {
      await removeWorktree(room.repoRoot, wtPath);
    } catch {
      rmSync(wtPath, { recursive: true, force: true });
    }
    worktreeRemoved = true;
  }

  const messages = store.listMessages(room.id);
  let diffsRemoved = 0;
  for (const m of messages) {
    const pathsToCheck = new Set<string>();
    pathsToCheck.add(diffPath(m.id));
    if (m.diffPath) pathsToCheck.add(m.diffPath);
    for (const dp of pathsToCheck) {
      if (existsSync(dp)) {
        try {
          rmSync(dp, { force: true });
          diffsRemoved += 1;
        } catch {
          // ignore
        }
      }
    }
  }

  const turns = store.listTurns(room.id);
  let turnsRemoved = 0;
  for (const t of turns) {
    const tp = turnLogPath(t.id);
    if (existsSync(tp)) {
      try {
        rmSync(tp, { force: true });
        turnsRemoved += 1;
      } catch {
        // ignore
      }
    }
  }

  store.purgeRoom(room.id);
  return { worktreeRemoved, diffsRemoved, turnsRemoved };
}
