import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { git } from '@agent-chat-room/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { NotFoundError } from '../errors.js';
import type { RoomSupervisor } from '../supervisor.js';

const BrowseQuery = z.object({ path: z.string().optional() });
const ListQuery = z.object({ limit: z.coerce.number().int().positive().max(200).optional() });

export interface BrowseEntry {
  name: string;
  path: string;
  isRepo: boolean;
}

export interface BrowseResult {
  path: string;
  /** Null at the filesystem root, where "up" has nowhere to go. */
  parent: string | null;
  entries: BrowseEntry[];
}

/**
 * The repo picker: recent repos from the store, plus a directory browser for the rest.
 *
 * This reads directories on demand, which is precisely why the origin check in
 * `security.ts` is not optional – a page you have open in another tab must not be able to
 * enumerate your home directory through a localhost port.
 */
export function repoRoutes(app: FastifyInstance, supervisor: RoomSupervisor): void {
  app.get('/api/repos', (request) => {
    const { limit } = ListQuery.parse(request.query);
    return supervisor.store.listRepos(limit ?? 20);
  });

  app.get('/api/repos/browse', async (request): Promise<BrowseResult> => {
    const query = BrowseQuery.parse(request.query);
    const path = resolve(query.path && query.path.trim() ? query.path : homedir());

    let names: string[];
    try {
      names = readdirSync(path, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch (err) {
      throw new NotFoundError(
        `cannot list ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Marking repos is the whole point of the picker, and `git rev-parse` per child is
    // cheap enough for one directory of subdirectories.
    const entries = await Promise.all(
      names.map(async (name): Promise<BrowseEntry> => {
        const child = join(path, name);
        const root = await git.repoRoot(child);
        return { name, path: child, isRepo: root === child };
      }),
    );

    const parent = dirname(path);
    return { path, parent: parent === path ? null : parent, entries };
  });
}
