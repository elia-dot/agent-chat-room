/**
 * Schema migrations, applied in order and tracked in `PRAGMA user_version`.
 *
 * PLAN.md section 4.3 says "numbered SQL files". These are numbered TypeScript constants
 * instead, because the build is a bare `tsc -b` with no asset-copy step – loose `.sql`
 * files would never reach `dist/` and the published package would fail to open its own
 * database. The numbering and the forward-only rule are unchanged.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const INIT = `
CREATE TABLE rooms (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL,
  title         TEXT NOT NULL,
  task          TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'build-review',
  repo_root     TEXT NOT NULL,
  base_branch   TEXT NOT NULL,
  room_branch   TEXT NOT NULL,
  base_sha      TEXT,
  worktree_path TEXT,
  state         TEXT NOT NULL DEFAULT 'idle',
  round         INTEGER NOT NULL DEFAULT 0,
  max_rounds    INTEGER NOT NULL DEFAULT 4,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  closed_at     TEXT
);

CREATE TABLE messages (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id TEXT,
  author      TEXT NOT NULL,
  role        TEXT,
  round       INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL,
  text        TEXT NOT NULL,
  verdict_json  TEXT,
  activity_json TEXT,
  diff        TEXT,
  diff_path   TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE participants (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  runtime       TEXT NOT NULL,
  role          TEXT NOT NULL,
  permission    TEXT NOT NULL,
  model         TEXT,
  session_id    TEXT,
  order_index   INTEGER NOT NULL DEFAULT 0,
  last_seen_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL
);

CREATE TABLE turns (
  id             TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  round          INTEGER NOT NULL,
  role           TEXT NOT NULL,
  permission     TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  ok             INTEGER,
  exit_code      INTEGER,
  error          TEXT,
  usage_json     TEXT,
  session_id     TEXT,
  log_path       TEXT
);

CREATE TABLE repos (
  path          TEXT PRIMARY KEY,
  last_used_at  TEXT NOT NULL,
  defaults_json TEXT
);

CREATE INDEX idx_messages_room ON messages(room_id, seq);
CREATE INDEX idx_turns_room_round ON turns(room_id, round);
CREATE INDEX idx_participants_room ON participants(room_id, order_index);
CREATE INDEX idx_rooms_updated ON rooms(updated_at DESC);
`;

/**
 * M2 makes the human a participant rather than a spectator, and that needs two facts the
 * round loop never had to persist: whether the human asked the loop to hold, and who is
 * meant to speak next. Both are additive and defaulted, so an M1 database opens fine.
 */
const INTERACTIVITY = `
ALTER TABLE rooms ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN next_speaker TEXT;
`;

/**
 * M3 gives a room somewhere to remember the pull request "Open PR" opened, so the button
 * turns into a link that survives a reload. Additive and defaulted, so an M2 database opens
 * without touching it – the same rule `002_interactivity` follows.
 */
const M3 = `
ALTER TABLE rooms ADD COLUMN pr_url TEXT;
`;

/** M4 persists the extra workspace roots a room owner explicitly grants to its agents. */
const ADDITIONAL_DIRS = `
ALTER TABLE rooms ADD COLUMN additional_dirs_json TEXT NOT NULL DEFAULT '[]';
`;

/**
 * M5 lets a room decide for itself how many times a failed turn is retried before the room
 * stops and asks the human. `0` is the historical behaviour – fail once, hand it over – so
 * an M4 database opens with exactly the semantics it had before.
 */
const TURN_RETRIES = `
ALTER TABLE rooms ADD COLUMN max_turn_retries INTEGER NOT NULL DEFAULT 0;
`;

/**
 * M6 lets a message carry files: the images and documents the human drops into the chat,
 * and the transcript snapshot taken when they reference another room. Nullable, so a
 * database written by an M5 acr reads back with no attachments rather than not at all.
 */
const ATTACHMENTS = `
ALTER TABLE messages ADD COLUMN attachments_json TEXT;
`;

export const migrations: readonly Migration[] = [
  { version: 1, name: '001_init', sql: INIT },
  { version: 2, name: '002_interactivity', sql: INTERACTIVITY },
  { version: 3, name: '003_m3', sql: M3 },
  { version: 4, name: '004_additional_dirs', sql: ADDITIONAL_DIRS },
  { version: 5, name: '005_turn_retries', sql: TURN_RETRIES },
  { version: 6, name: '006_attachments', sql: ATTACHMENTS },
] as const;

export const LATEST_VERSION: number = migrations.reduce((max, m) => Math.max(max, m.version), 0);
