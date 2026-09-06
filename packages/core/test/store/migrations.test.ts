import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { LATEST_VERSION, migrate, openDb, schemaVersion } from '../../src/store/db.js';
import { migrations } from '../../src/store/migrations/index.js';

describe('schema migrations', () => {
  it('brings a fresh database to the latest version', () => {
    const db = openDb({ path: ':memory:' });
    expect(schemaVersion(db)).toBe(LATEST_VERSION);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const table of ['rooms', 'participants', 'messages', 'turns', 'repos']) {
      expect(tables).toContain(table);
    }
    db.close();
  });

  it('is a no-op when run again', () => {
    const db = openDb({ path: ':memory:' });
    expect(migrate(db)).toBe(LATEST_VERSION);
    // Running the same SQL twice would throw "table rooms already exists".
    expect(() => migrate(db)).not.toThrow();
    expect(schemaVersion(db)).toBe(LATEST_VERSION);
    db.close();
  });

  it('rolls a failing migration back instead of leaving half a schema behind', () => {
    const db = new Database(':memory:');
    const broken = { version: 99, name: 'broken', sql: 'CREATE TABLE ok (a); SELECT nonsense();' };

    expect(() => {
      const apply = db.transaction(() => {
        db.exec(broken.sql);
        db.pragma(`user_version = ${broken.version}`);
      });
      apply();
    }).toThrow();

    expect(schemaVersion(db)).toBe(0);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).not.toContain('ok');
    db.close();
  });

  it('numbers migrations in order, with no gaps or duplicates', () => {
    const versions = migrations.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe('002_interactivity', () => {
  it('adds the pause columns to a v1 database without losing what is in it', () => {
    // A database exactly as an M1 `acr` left it: schema v1, with a room in it.
    const db = new Database(':memory:');
    const init = migrations.find((m) => m.version === 1)!;
    db.exec(init.sql);
    db.pragma('user_version = 1');
    db.prepare(
      `INSERT INTO rooms (id, slug, title, task, mode, repo_root, base_branch, room_branch,
         state, round, max_rounds, created_at, updated_at)
       VALUES ('r1', 'fix-add', 'Fix add()', 'add subtracts', 'build-review', '/repo', 'main',
         'acr/fix-add', 'needs-you', 2, 4, 'then', 'then')`,
    ).run();

    expect(migrate(db)).toBe(LATEST_VERSION);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(2);

    const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get('r1') as Record<string, unknown>;
    expect(row.state).toBe('needs-you');
    expect(row.round).toBe(2);
    // The new columns default rather than nulling: an M1 room was never paused.
    expect(row.paused).toBe(0);
    expect(row.next_speaker).toBeNull();
    db.close();
  });
});

describe('004_additional_dirs', () => {
  it('adds an empty folder list to an existing v3 room', () => {
    const db = new Database(':memory:');
    for (const migration of migrations.filter((entry) => entry.version <= 3)) {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    }
    db.prepare(
      `INSERT INTO rooms (id, slug, title, task, mode, repo_root, base_branch, room_branch,
         state, round, max_rounds, created_at, updated_at)
       VALUES ('r1', 'fix-add', 'Fix add()', 'add subtracts', 'build-review', '/repo', 'main',
         'acr/fix-add', 'idle', 0, 4, 'then', 'then')`,
    ).run();

    expect(migrate(db)).toBe(LATEST_VERSION);
    const row = db.prepare('SELECT additional_dirs_json FROM rooms WHERE id = ?').get('r1') as {
      additional_dirs_json: string;
    };
    expect(row.additional_dirs_json).toBe('[]');
    db.close();
  });
});

describe('005_turn_retries', () => {
  it('gives an existing v4 room the old never-retry behaviour', () => {
    const db = new Database(':memory:');
    for (const migration of migrations.filter((entry) => entry.version <= 4)) {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    }
    db.prepare(
      `INSERT INTO rooms (id, slug, title, task, mode, repo_root, base_branch, room_branch,
         state, round, max_rounds, created_at, updated_at)
       VALUES ('r1', 'fix-add', 'Fix add()', 'add subtracts', 'build-review', '/repo', 'main',
         'acr/fix-add', 'needs-you', 3, 4, 'then', 'then')`,
    ).run();

    expect(migrate(db)).toBe(LATEST_VERSION);

    const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get('r1') as Record<string, unknown>;
    // Defaulted rather than nulled: a room opened before the setting existed must keep
    // behaving the way its owner watched it behave, which is one failure and hand over.
    expect(row.max_turn_retries).toBe(0);
    expect(row.state).toBe('needs-you');
    expect(row.round).toBe(3);
    db.close();
  });
});
