import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as git from '../src/git.js';
import {
  branchFor,
  createWorktree,
  ensureWorktree,
  removeWorktree,
  slugify,
  uniqueSlug,
} from '../src/worktree.js';
import { gitIn, makeRepo, useTempConfigDir } from './helpers.js';

const BROKEN = 'export const add = (a, b) => a - b;\n';

let config: ReturnType<typeof useTempConfigDir>;
const repos: string[] = [];

function repo(): string {
  const dir = makeRepo({ 'math.js': BROKEN });
  repos.push(dir);
  return dir;
}

beforeEach(() => {
  config = useTempConfigDir();
});

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  config.restore();
});

describe('slugify', () => {
  it('turns a title into a branch-safe slug', () => {
    expect(slugify('Fix the flaky login test')).toBe('fix-the-flaky-login-test');
    expect(slugify('  Weird!! punctuation?? ')).toBe('weird-punctuation');
    expect(slugify('')).toBe('room');
    expect(slugify('x'.repeat(80)).length).toBeLessThanOrEqual(40);
  });

  it('does not leave a trailing dash when the cap lands on one', () => {
    expect(slugify(`${'a'.repeat(39)} tail`)).not.toMatch(/-$/);
  });
});

describe('room worktrees', () => {
  it('creates the room branch off HEAD and leaves the checkout untouched', async () => {
    const dir = repo();
    const head = await git.headSha(dir);

    const worktree = await createWorktree({
      repoRoot: dir,
      roomId: 'room-1',
      branch: branchFor('fix-add'),
    });

    expect(existsSync(join(worktree.path, 'math.js'))).toBe(true);
    expect(worktree.baseSha).toBe(head);
    expect(gitIn(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('acr/fix-add');

    // The worker writes in the worktree; the human's checkout does not move.
    writeFileSync(join(worktree.path, 'math.js'), 'export const add = (a, b) => a + b;\n');
    expect(readFileSync(join(dir, 'math.js'), 'utf8')).toBe(BROKEN);
    expect(await git.isDirty(dir)).toBe(false);
    expect(await git.isDirty(worktree.path)).toBe(true);

    // The diff is taken against the room's base, and it sees the edit.
    expect(await git.diffSince(worktree.path, worktree.baseSha)).toContain('a + b');

    await removeWorktree(dir, worktree.path);
    expect(existsSync(worktree.path)).toBe(false);
    expect(gitIn(dir, 'worktree', 'list')).not.toContain(worktree.path);
    // Removing the worktree keeps the branch: that is what you merge or open a PR from.
    expect(await git.branchExists(dir, 'acr/fix-add')).toBe(true);
  });

  it('picks a fresh slug when the branch is already taken', async () => {
    const dir = repo();
    expect(await uniqueSlug(dir, 'Fix add')).toBe('fix-add');

    await createWorktree({ repoRoot: dir, roomId: 'room-1', branch: branchFor('fix-add') });
    const second = await uniqueSlug(dir, 'Fix add', 'abcdef');
    expect(second).not.toBe('fix-add');
    expect(await git.branchExists(dir, branchFor(second))).toBe(false);
  });

  it('re-attaches a room to its branch when the directory is gone', async () => {
    const dir = repo();
    const worktree = await createWorktree({
      repoRoot: dir,
      roomId: 'room-1',
      branch: branchFor('fix-add'),
    });
    writeFileSync(join(worktree.path, 'new.txt'), 'work\n');
    gitIn(worktree.path, 'add', '-A');
    gitIn(worktree.path, 'commit', '-qm', 'round 1');

    // Someone cleaned ~/.config. The branch is still there, which is the point of
    // committing to a branch rather than trusting a directory.
    rmSync(worktree.path, { recursive: true, force: true });

    const again = await ensureWorktree({
      repoRoot: dir,
      path: worktree.path,
      branch: branchFor('fix-add'),
    });
    expect(existsSync(join(again.path, 'new.txt'))).toBe(true);
  });

  it('is a no-op when the worktree is already there', async () => {
    const dir = repo();
    const worktree = await createWorktree({
      repoRoot: dir,
      roomId: 'room-1',
      branch: branchFor('fix-add'),
    });
    writeFileSync(join(worktree.path, 'scratch.txt'), 'in flight\n');
    const again = await ensureWorktree({
      repoRoot: dir,
      path: worktree.path,
      branch: branchFor('fix-add'),
    });
    expect(again.path).toBe(worktree.path);
    expect(existsSync(join(worktree.path, 'scratch.txt'))).toBe(true);
  });
});

describe('git.commitAll', () => {
  it('commits everything in the worktree and reports the sha', async () => {
    const dir = repo();
    const worktree = await createWorktree({
      repoRoot: dir,
      roomId: 'room-1',
      branch: branchFor('fix-add'),
    });
    writeFileSync(join(worktree.path, 'math.js'), 'export const add = (a, b) => a + b;\n');
    writeFileSync(join(worktree.path, 'new.js'), 'export const x = 1;\n');

    const result = await git.commitAll(worktree.path, 'acr: Fix add()', 'swapped the operator');
    expect(result.ok).toBe(true);
    expect(result.shortSha).toBeTruthy();

    const log = gitIn(worktree.path, 'log', '-1', '--pretty=%s%n%b');
    expect(log).toContain('acr: Fix add()');
    expect(log).toContain('swapped the operator');
    // Untracked files are part of the round, not left behind.
    expect(gitIn(worktree.path, 'show', '--name-only', '--pretty=', 'HEAD')).toContain('new.js');
  });

  it('reports "nothing staged" instead of making an empty commit', async () => {
    const dir = repo();
    const worktree = await createWorktree({
      repoRoot: dir,
      roomId: 'room-1',
      branch: branchFor('fix-add'),
    });
    const result = await git.commitAll(worktree.path, 'acr: nothing');
    expect(result.ok).toBe(false);
    expect(result.empty).toBe(true);
  });
});
