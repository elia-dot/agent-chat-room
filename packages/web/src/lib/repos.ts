import type { RepoRecord } from '@agent-chat-room/core';

import { basename } from './format.js';

/**
 * Narrow the recent-projects list.
 *
 * A pure function rather than logic inside the dialog because the web test project runs in
 * node, not jsdom (see `vitest.config.ts`) – this is the part worth pinning, and here it is
 * testable without dragging a DOM in for one component.
 */
export function filterRepos(repos: RepoRecord[], query: string): RepoRecord[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return repos;
  return repos.filter(
    (repo) =>
      repo.path.toLowerCase().includes(needle) ||
      basename(repo.path).toLowerCase().includes(needle),
  );
}
