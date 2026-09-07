import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import * as git from '../src/git.js';
import { gitIn, makeRepo } from './helpers.js';

const repos: string[] = [];

function repo(): string {
  const dir = makeRepo({ 'math.js': 'export const add = (a, b) => a - b;\n' });
  repos.push(dir);
  return dir;
}

/** A room branch with one commit on it, left checked out on `main` afterwards. */
function withRoomBranch(dir: string, branch = 'acr/fix-add', contents = 'FIXED\n'): void {
  gitIn(dir, 'checkout', '-q', '-b', branch);
  writeFileSync(join(dir, 'math.js'), contents);
  gitIn(dir, 'commit', '-qam', 'fix add');
  gitIn(dir, 'checkout', '-q', 'main');
}

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('mergeBranch', () => {
  it('merges the room branch into the branch the checkout is on', async () => {
    const dir = repo();
    withRoomBranch(dir);

    const result = await git.mergeBranch(dir, 'acr/fix-add', { into: 'main' });

    expect(result.ok).toBe(true);
    expect(result.shortSha).toBeTruthy();
    expect(gitIn(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(gitIn(dir, 'log', '-1', '--pretty=%P').split(' ')).toHaveLength(2);
  });

  it('takes the message it is given', async () => {
    const dir = repo();
    withRoomBranch(dir);

    const message = 'acr: fix add\n\nRoom: r1';
    await git.mergeBranch(dir, 'acr/fix-add', { into: 'main', message });

    expect(gitIn(dir, 'log', '-1', '--pretty=%s')).toBe('acr: fix add');
    expect(gitIn(dir, 'log', '-1', '--pretty=%b')).toContain('Room: r1');
  });

  it('reports "already up to date" instead of writing an empty merge commit', async () => {
    const dir = repo();
    withRoomBranch(dir);
    await git.mergeBranch(dir, 'acr/fix-add', { into: 'main' });
    const before = gitIn(dir, 'rev-parse', 'HEAD');

    const again = await git.mergeBranch(dir, 'acr/fix-add', { into: 'main' });

    expect(again).toMatchObject({ ok: true, alreadyUpToDate: true });
    expect(gitIn(dir, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('refuses a checkout standing on some other branch', async () => {
    const dir = repo();
    withRoomBranch(dir);
    gitIn(dir, 'checkout', '-q', '-b', 'somewhere-else');

    const result = await git.mergeBranch(dir, 'acr/fix-add', { into: 'main' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('somewhere-else');
    expect(result.error).toContain('main');
  });

  it('refuses a dirty checkout rather than merging over uncommitted work', async () => {
    const dir = repo();
    withRoomBranch(dir);
    writeFileSync(join(dir, 'math.js'), 'half-finished\n');

    const result = await git.mergeBranch(dir, 'acr/fix-add', { into: 'main' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/uncommitted/);
    expect(gitIn(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('refuses a branch that does not exist', async () => {
    const dir = repo();

    const result = await git.mergeBranch(dir, 'acr/never-was', { into: 'main' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('acr/never-was');
  });

  it('refuses a checkout that is already part-way through a merge', async () => {
    // The case `isDirty` cannot see: the human resolved the conflict to match HEAD, so the
    // tree is clean while MERGE_HEAD is still there. Starting a merge here would fail, and
    // the failure path used to abort *their* merge on the way out.
    const dir = repo();
    withRoomBranch(dir, 'acr/fix-add', 'from the room\n');
    // A branch of the human's own that conflicts with main…
    gitIn(dir, 'checkout', '-q', '-b', 'theirs');
    writeFileSync(join(dir, 'math.js'), 'from theirs\n');
    gitIn(dir, 'commit', '-qam', 'theirs');
    gitIn(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'math.js'), 'from the human\n');
    gitIn(dir, 'commit', '-qam', 'mine');
    // …which they started merging and then resolved back to HEAD's content.
    try {
      gitIn(dir, 'merge', '--no-ff', '-m', 'theirs', 'theirs');
    } catch {
      // expected: it conflicts, which is the state under test
    }
    gitIn(dir, 'checkout', '--ours', '--', 'math.js');
    gitIn(dir, 'add', 'math.js');
    expect(await git.isDirty(dir)).toBe(false);
    expect(await git.pendingOperation(dir)).toBe('merge');

    const result = await git.mergeBranch(dir, 'acr/fix-add', { into: 'main' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/part-way through a merge/);
    // Their merge is still there, waiting for them to finish it.
    expect(await git.pendingOperation(dir)).toBe('merge');
  });

  it('aborts a conflicting merge instead of leaving the repo mid-conflict', async () => {
    const dir = repo();
    withRoomBranch(dir, 'acr/fix-add', 'from the room\n');
    // A conflicting commit on main, made after the room branched.
    writeFileSync(join(dir, 'math.js'), 'from the human\n');
    gitIn(dir, 'commit', '-qam', 'diverge');
    const before = gitIn(dir, 'rev-parse', 'HEAD');

    const result = await git.mergeBranch(dir, 'acr/fix-add', { into: 'main' });

    expect(result.ok).toBe(false);
    expect(gitIn(dir, 'rev-parse', 'HEAD')).toBe(before);
    expect(await git.isDirty(dir)).toBe(false);
  });
});
