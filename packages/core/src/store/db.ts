import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { dbPath } from '../paths.js';
import { LATEST_VERSION, migrations } from './migrations/index.js';

export type Db = Database.Database;

export interface OpenDbOptions {
  /** Defaults to `dbPath()`. Pass `':memory:'` for a throwaway database. */
  path?: string;
  /** Skip migrations. Only useful for inspecting an existing file. */
  migrate?: boolean;
}

/**
 * Open the room database.
 *
 * WAL so a reader – the future server, or a second `acr` – never blocks the engine mid
 * turn; `foreign_keys` on because the whole cascade-delete story depends on it; a busy
 * timeout because two `acr` processes on one machine is an ordinary situation, not a bug.
 */
export function openDb(opts: OpenDbOptions = {}): Db {
  const path = opts.path ?? dbPath();
  const memory = path === ':memory:';
  if (!memory) mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  if (!memory) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  if (opts.migrate !== false) migrate(db);
  return db;
}

export function schemaVersion(db: Db): number {
  const rows = db.pragma('user_version') as { user_version: number }[];
  return rows[0]?.user_version ?? 0;
}

/**
 * Apply every migration newer than `user_version`, each in its own transaction, so a
 * migration that fails half way leaves the database exactly where it started rather than
 * in a shape no version of `acr` understands.
 */
export function migrate(db: Db): number {
  let current = schemaVersion(db);
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (migration.version <= current) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      // `PRAGMA user_version` takes no bound parameters; the value is our own integer.
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
    current = migration.version;
  }
  return current;
}

export { LATEST_VERSION, migrations };
export type { Migration } from './migrations/index.js';
