import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import * as git from '../git.js';
import type { AdditionalDir } from '../store/types.js';

/**
 * An additional folder, resolved to the repository it lives in.
 *
 * The grant is a folder; everything the room does with it – diff, commit, branch, PR – is
 * a repository operation, so the two are resolved apart exactly once, here.
 */
export interface AdditionalRepo {
  root: string;
  dir: AdditionalDir;
}

/** Work a writable additional repository is holding. */
export interface AdditionalRepoChange extends AdditionalRepo {
  branch: string;
  /** `git diff HEAD` plus untracked files, exactly like the room's own diff. */
  diff: string;
  stat: string;
  /** Paths relative to `root`. */
  changed: string[];
}

/**
 * The distinct repositories behind `dirs`, minus the ones the room already covers.
 *
 * Folders that are not in a repository are dropped: they are still readable and writable
 * by the agents, there is simply no diff, commit or pull request to make of them. Two
 * granted folders in one repository collapse to one entry, and the more permissive grant
 * wins – asking for write access to a subfolder is asking for it in that repository.
 */
export async function additionalRepos(
  dirs: readonly AdditionalDir[],
  exclude: readonly string[] = [],
): Promise<AdditionalRepo[]> {
  const excluded = new Set(exclude);
  const repos: AdditionalRepo[] = [];
  for (const dir of dirs) {
    const root = await git.repoRoot(dir.path);
    if (!root || excluded.has(root)) continue;
    const existing = repos.find((r) => r.root === root);
    if (!existing) {
      repos.push({ root, dir });
    } else if (dir.access === 'write' && existing.dir.access === 'read') {
      existing.dir = dir;
    }
  }
  return repos;
}

/**
 * Re-granting the same folder must not forget where its work went.
 *
 * Editing folder access re-validates the whole list, which builds fresh entries. Any folder
 * that survives the edit keeps the branch the room cut in it and the pull request it opened,
 * because those exist out on disk whatever the settings panel now says.
 */
export function carryOverDirState(
  next: readonly AdditionalDir[],
  previous: readonly AdditionalDir[],
): AdditionalDir[] {
  return next.map((dir) => {
    const before = previous.find((p) => p.path === dir.path);
    if (!before) return dir;
    return { ...dir, branch: before.branch, baseBranch: before.baseBranch, prUrl: before.prUrl };
  });
}

/** Only the ones the room may change – the folders whose work it owns. */
export async function writableRepos(
  dirs: readonly AdditionalDir[],
  exclude: readonly string[] = [],
): Promise<AdditionalRepo[]> {
  return (await additionalRepos(dirs, exclude)).filter((r) => r.dir.access === 'write');
}

/** The uncommitted state of every writable additional repository, skipping the clean ones. */
export async function collectAdditionalRepoChanges(
  dirs: readonly AdditionalDir[],
  exclude: readonly string[] = [],
): Promise<AdditionalRepoChange[]> {
  const changes: AdditionalRepoChange[] = [];
  for (const repo of await writableRepos(dirs, exclude)) {
    const changed = await git.changedFiles(repo.root, 'HEAD');
    if (changed.length === 0) continue;
    changes.push({
      ...repo,
      branch: await git.currentBranch(repo.root),
      diff: await git.diffSince(repo.root, 'HEAD'),
      stat: await git.diffStat(repo.root, 'HEAD'),
      changed,
    });
  }
  return changes;
}

// --- read-only enforcement -------------------------------------------------

/**
 * What each read-only repository was holding before a turn: for every path that was
 * already dirty, a hash of what was in it.
 *
 * A path alone is not enough. If the human left a file modified and the agent then edited
 * that same file, both states are "dirty" – only the content says which one is there now.
 */
export type ReadOnlySnapshot = Map<string, Map<string, string | null>>;

async function hashFile(path: string): Promise<string | null> {
  try {
    return createHash('sha1')
      .update(await readFile(path))
      .digest('hex');
  } catch {
    // Deleted, unreadable, or a directory: "no content" is a state like any other.
    return null;
  }
}

export async function snapshotReadOnly(
  dirs: readonly AdditionalDir[],
  exclude: readonly string[] = [],
): Promise<ReadOnlySnapshot> {
  const snapshot: ReadOnlySnapshot = new Map();
  for (const repo of await additionalRepos(dirs, exclude)) {
    if (repo.dir.access !== 'read') continue;
    const dirty = new Map<string, string | null>();
    for (const path of await git.changedFiles(repo.root, 'HEAD')) {
      dirty.set(path, await hashFile(join(repo.root, path)));
    }
    snapshot.set(repo.root, dirty);
  }
  return snapshot;
}

export interface ReadOnlyViolation {
  root: string;
  /** Edits the room undid, because the file was untouched when the turn started. */
  reverted: string[];
  /** Edits it could not undo: the file was already dirty, so HEAD is not what to restore. */
  kept: string[];
}

/**
 * Undo whatever a turn changed in a read-only folder.
 *
 * `--add-dir` is all-or-nothing – no runtime offers a read-only workspace root – so the
 * prompt asks and this enforces. Only files that were clean when the turn started are
 * restored; a file the human had already modified is reported instead, because restoring
 * it from HEAD would throw away their work in order to undo the agent's.
 */
export async function revertReadOnly(
  dirs: readonly AdditionalDir[],
  before: ReadOnlySnapshot,
  exclude: readonly string[] = [],
): Promise<ReadOnlyViolation[]> {
  const violations: ReadOnlyViolation[] = [];
  for (const repo of await additionalRepos(dirs, exclude)) {
    if (repo.dir.access !== 'read') continue;
    const wasDirty = before.get(repo.root) ?? new Map<string, string | null>();

    const restorable: string[] = [];
    const kept: string[] = [];
    for (const path of await git.changedFiles(repo.root, 'HEAD')) {
      if (!wasDirty.has(path)) {
        restorable.push(path);
        continue;
      }
      // Already dirty when the turn started. Only a changed hash means the agent wrote it,
      // and there is no clean version of it to go back to.
      if (wasDirty.get(path) !== (await hashFile(join(repo.root, path)))) kept.push(path);
    }
    if (restorable.length === 0 && kept.length === 0) continue;

    const untracked = new Set(await git.listUntracked(repo.root));
    await git.checkoutPaths(
      repo.root,
      restorable.filter((p) => !untracked.has(p)),
    );
    for (const path of restorable.filter((p) => untracked.has(p))) {
      try {
        await rm(join(repo.root, path), { force: true });
      } catch {
        kept.push(path);
      }
    }

    // Whatever is still dirty afterwards did not come back, so report it rather than
    // claiming an undo that did not happen.
    const stillThere = new Set(await git.changedFiles(repo.root, 'HEAD'));
    for (const path of restorable) {
      if (stillThere.has(path) && !kept.includes(path)) kept.push(path);
    }
    violations.push({
      root: repo.root,
      reverted: restorable.filter((p) => !kept.includes(p)),
      kept,
    });
  }
  return violations;
}

// --- rendering -------------------------------------------------------------

/**
 * The banner that separates one repository's diff from the next.
 *
 * It has to be inert to a diff parser – `parseModifiedHunks` only reacts to `diff --git`
 * and `@@` lines – while still telling a reviewer which repository the paths below belong
 * to, since they are relative to that repository and can collide with the room's own.
 */
function banner(change: AdditionalRepoChange): string {
  return `==== additional folder ${change.root} (branch ${change.branch}, uncommitted) ====`;
}

/** Room diff first, then one section per additional repository. */
export function appendAdditionalDiffs(
  diff: string,
  changes: readonly AdditionalRepoChange[],
): string {
  if (changes.length === 0) return diff;
  const sections = changes.map((c) => `${banner(c)}\n${c.diff.replace(/\n+$/, '')}\n`);
  return [diff.replace(/\n+$/, ''), ...sections].filter((s) => s.trim().length > 0).join('\n\n');
}

/** Same shape for the `--stat` summary the prompt puts above the diff. */
export function appendAdditionalStats(
  stat: string,
  changes: readonly AdditionalRepoChange[],
): string {
  if (changes.length === 0) return stat;
  const sections = changes.map((c) => `${banner(c)}\n${c.stat.trim()}`);
  return [stat.trim(), ...sections].filter((s) => s.length > 0).join('\n\n');
}

/** Changed paths, qualified by repository so a room-wide list stays unambiguous. */
export function qualifiedChangedFiles(changes: readonly AdditionalRepoChange[]): string[] {
  return changes.flatMap((c) => c.changed.map((f) => `${c.root}/${f}`));
}
