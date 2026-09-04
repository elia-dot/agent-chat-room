import type { RepoRecord } from '@agent-chat-room/core';
import { describe, expect, it } from 'vitest';

import { filterRepos } from '../src/lib/repos.js';

const repos: RepoRecord[] = [
  {
    path: '/Users/you/code/agent-chat-room',
    lastUsedAt: '2026-09-04T09:00:00.000Z',
    defaults: null,
  },
  { path: '/Users/you/code/Denly', lastUsedAt: '2026-09-03T09:00:00.000Z', defaults: null },
  { path: '/Users/you/work/invoices', lastUsedAt: '2026-09-01T09:00:00.000Z', defaults: null },
];

const paths = (list: RepoRecord[]): string[] => list.map((r) => r.path);

describe('filtering recent projects', () => {
  it('returns everything when nothing has been typed', () => {
    expect(paths(filterRepos(repos, ''))).toEqual(paths(repos));
    expect(paths(filterRepos(repos, '   '))).toEqual(paths(repos));
  });

  it('matches the name you remember, whatever case you type it in', () => {
    expect(paths(filterRepos(repos, 'denly'))).toEqual(['/Users/you/code/Denly']);
    expect(paths(filterRepos(repos, 'CHAT'))).toEqual(['/Users/you/code/agent-chat-room']);
  });

  it('matches a fragment of the parent path too, which is how you narrow by area', () => {
    expect(paths(filterRepos(repos, 'work'))).toEqual(['/Users/you/work/invoices']);
    expect(paths(filterRepos(repos, '/code/'))).toEqual([
      '/Users/you/code/agent-chat-room',
      '/Users/you/code/Denly',
    ]);
  });

  it('is empty rather than surprising when nothing matches', () => {
    expect(filterRepos(repos, 'nope')).toEqual([]);
  });
});
