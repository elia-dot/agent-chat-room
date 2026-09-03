import { describe, expect, it } from 'vitest';

import type { GhRunner } from '../src/gh.js';
import { buildCreatePrArgs, createPr } from '../src/gh.js';

const input = {
  cwd: '/wt',
  base: 'main',
  head: 'acr/fix-add',
  title: 'acr: Fix add()',
  body: 'the task',
};

/** No test may push anything or reach the network, so `gh` is always a fake here. */
function fakeGh(
  reply: { code: number | null; stdout?: string; stderr?: string },
  seen: string[][] = [],
): GhRunner {
  return (args) => {
    seen.push(args);
    return Promise.resolve({
      code: reply.code,
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
    });
  };
}

describe('buildCreatePrArgs', () => {
  it('names the base and head explicitly rather than trusting the checkout', () => {
    expect(buildCreatePrArgs(input)).toEqual([
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      'acr/fix-add',
      '--title',
      'acr: Fix add()',
      '--body',
      'the task',
    ]);
  });

  it('always passes a body, because gh opens an editor when it has neither body nor fill', () => {
    const args = buildCreatePrArgs({ ...input, body: undefined });
    expect(args).toEqual(expect.arrayContaining(['--body', '']));
  });

  it('adds --draft only when asked', () => {
    expect(buildCreatePrArgs(input)).not.toContain('--draft');
    expect(buildCreatePrArgs({ ...input, draft: true })).toContain('--draft');
  });
});

describe('createPr', () => {
  it('returns the url gh printed', async () => {
    const result = await createPr(
      input,
      fakeGh({ code: 0, stdout: 'https://github.com/o/r/pull/7\n' }),
    );
    expect(result).toEqual({ ok: true, url: 'https://github.com/o/r/pull/7' });
  });

  it('treats "a PR already exists" as the url it names, not as a failure', async () => {
    const result = await createPr(
      input,
      fakeGh({
        code: 1,
        stderr:
          'a pull request for branch "acr/fix-add" already exists: https://github.com/o/r/pull/7',
      }),
    );
    expect(result).toEqual({ ok: true, url: 'https://github.com/o/r/pull/7' });
  });

  it('reports a real failure as a result rather than throwing', async () => {
    const result = await createPr(input, fakeGh({ code: 1, stderr: 'gh: not logged in\n' }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not logged in');
  });

  it('runs gh in the room worktree', async () => {
    let cwd = '';
    await createPr(input, (_args, dir) => {
      cwd = dir;
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    });
    expect(cwd).toBe('/wt');
  });
});
