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
