import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { diffPath as diffFilePath, roomAttachmentsDir } from '../paths.js';
import type { Role } from '../roles.js';
import type { Permission, TurnEvent, Usage } from '../types.js';
import type { Verdict } from '../verdict.js';
import type { Db } from './db.js';
import { openDb } from './db.js';
import type {
  AdditionalDir,
  Attachment,
  Message,
  MessageKind,
  Participant,
  RepoRecord,
  Room,
  RoomMode,
  RoomState,
  TurnRecord,
} from './types.js';

/**
 * A diff bigger than this is written next to the database instead of into it. One agent
 * that rewrites a lockfile should not turn `acr.db` into a hundred megabytes.
 */
export const MAX_INLINE_DIFF_BYTES = 1024 * 1024;

export interface CreateRoomInput {
  id?: string;
  slug: string;
  title: string;
  task: string;
  mode?: RoomMode;
  repoRoot: string;
  additionalDirs?: AdditionalDir[];
  baseBranch: string;
  roomBranch: string;
  baseSha?: string | null;
  worktreePath?: string | null;
  maxRounds?: number;
  maxTurnRetries?: number;
  state?: RoomState;
  round?: number;
}

export interface AddParticipantInput {
  id?: string;
  roomId: string;
  runtime: string;
  role: Role;
  permission: Permission;
  model?: string | null;
  orderIndex: number;
  sessionId?: string | null;
}

export interface AddMessageInput {
  id?: string;
  roomId: string;
  participantId?: string | null;
  author: string;
  role?: string | null;
  round?: number;
  kind: MessageKind;
  text: string;
  verdict?: Verdict | null;
  activity?: TurnEvent[];
  diff?: string | null;
  attachments?: Attachment[];
}

export interface StartTurnInput {
  id?: string;
  roomId: string;
  participantId: string;
  round: number;
  role: string;
  permission: Permission;
  logPath?: string | null;
}

export interface FinishTurnInput {
  ok: boolean;
  exitCode?: number | null;
  error?: string | null;
  usage?: Usage | null;
  sessionId?: string | null;
}

type Row = Record<string, unknown>;

/**
 * Every SQL statement in the project lives here.
 *
 * That is deliberate rather than tidy-minded: `better-sqlite3` is the one native
 * dependency `acr` has, and so its biggest install risk. Keeping the
 * engine ignorant of SQL means swapping it for `node:sqlite` later is one file, not a
 * refactor.
 */
export class RoomStore {
  readonly db: Db;
  private readonly ownsDb: boolean;

  constructor(db?: Db) {
    this.db = db ?? openDb();
    this.ownsDb = db === undefined;
  }

  /** Convenience for tests and short-lived commands. */
  static open(path?: string): RoomStore {
    return new RoomStore(openDb(path === undefined ? {} : { path }));
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }

  // --- rooms ---------------------------------------------------------------

  createRoom(input: CreateRoomInput): Room {
    const now = nowIso();
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO rooms (id, slug, title, task, mode, repo_root, additional_dirs_json,
           base_branch, room_branch, base_sha, worktree_path, state, round, max_rounds,
           max_turn_retries, created_at, updated_at)
         VALUES (@id, @slug, @title, @task, @mode, @repoRoot, @additionalDirsJson,
           @baseBranch, @roomBranch, @baseSha, @worktreePath, @state, @round, @maxRounds,
           @maxTurnRetries, @createdAt, @updatedAt)`,
      )
      .run({
        id,
        slug: input.slug,
        title: input.title,
        task: input.task,
        mode: input.mode ?? 'build-review',
        repoRoot: input.repoRoot,
        additionalDirsJson: JSON.stringify(input.additionalDirs ?? []),
        baseBranch: input.baseBranch,
        roomBranch: input.roomBranch,
        baseSha: input.baseSha ?? null,
        worktreePath: input.worktreePath ?? null,
        state: input.state ?? 'idle',
        round: input.round ?? 0,
        maxRounds: input.maxRounds ?? 4,
        maxTurnRetries: input.maxTurnRetries ?? 0,
        createdAt: now,
        updatedAt: now,
      });
    return this.getRoom(id)!;
  }

  getRoom(id: string): Room | undefined {
    const row = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as Row | undefined;
    return row ? toRoom(row) : undefined;
  }

  /**
   * Room ids are uuids and nobody is going to type one, so `acr rooms show 3f2a` resolves
   * by prefix. An ambiguous prefix is an error rather than a coin flip.
   */
  findRoom(idOrPrefixOrSlug: string): Room | undefined {
    const exact = this.getRoom(idOrPrefixOrSlug);
    if (exact) return exact;

    // An exact slug beats a partial id: `acr rooms show flaky-login` should not become
    // ambiguous just because two room ids happen to start with the same letters.
    const bySlug = this.db
      .prepare('SELECT * FROM rooms WHERE slug = ? ORDER BY updated_at DESC')
      .all(idOrPrefixOrSlug) as Row[];
    if (bySlug.length === 1) return toRoom(bySlug[0]!);

    const rows =
      bySlug.length > 1
        ? bySlug
        : (this.db
            .prepare('SELECT * FROM rooms WHERE id LIKE ? ORDER BY updated_at DESC')
            .all(`${idOrPrefixOrSlug}%`) as Row[]);
    if (rows.length === 0) return undefined;
    if (rows.length > 1) {
      throw new Error(
        `"${idOrPrefixOrSlug}" matches ${rows.length} rooms: ${rows
          .map((r) => asText(r.id).slice(0, 8))
          .join(', ')}`,
      );
    }
    return toRoom(rows[0]!);
  }

  listRooms(opts: { repoRoot?: string; open?: boolean; limit?: number } = {}): Room[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.repoRoot) {
      where.push('repo_root = ?');
      params.push(opts.repoRoot);
    }
    if (opts.open !== undefined) {
      where.push(opts.open ? 'closed_at IS NULL' : 'closed_at IS NOT NULL');
    }
    const sql =
      `SELECT * FROM rooms${where.length ? ` WHERE ${where.join(' AND ')}` : ''}` +
      ` ORDER BY updated_at DESC${opts.limit ? ' LIMIT ?' : ''}`;
    if (opts.limit) params.push(opts.limit);
    return (this.db.prepare(sql).all(...params) as Row[]).map(toRoom);
  }

  purgeRoom(id: string): void {
    this.deleteRoom(id);
  }

  updateRoom(
    id: string,
    patch: Partial<
      Pick<
        Room,
        | 'state'
        | 'paused'
        | 'nextSpeaker'
        | 'round'
        | 'maxRounds'
        | 'maxTurnRetries'
        | 'baseSha'
        | 'worktreePath'
        | 'closedAt'
        | 'title'
        | 'prUrl'
        | 'additionalDirs'
      >
    >,
  ): Room {
    const sets: string[] = [];
    const params: Row = { id, updatedAt: nowIso() };
    const map: Record<string, string> = {
      state: 'state',
      paused: 'paused',
      nextSpeaker: 'next_speaker',
      round: 'round',
      maxRounds: 'max_rounds',
      maxTurnRetries: 'max_turn_retries',
      baseSha: 'base_sha',
      worktreePath: 'worktree_path',
      closedAt: 'closed_at',
      title: 'title',
      prUrl: 'pr_url',
      additionalDirs: 'additional_dirs_json',
    };
    for (const [key, column] of Object.entries(map)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = @${key}`);
      // `paused` is a boolean here and an INTEGER in SQLite; better-sqlite3 refuses to bind
      // a JavaScript boolean, so it is the one column that needs converting on the way in.
      const value = (patch as Row)[key];
      params[key] =
        key === 'paused'
          ? value
            ? 1
            : 0
          : key === 'additionalDirs'
            ? JSON.stringify(value ?? [])
            : (value ?? null);
    }
    sets.push('updated_at = @updatedAt');
    this.db.prepare(`UPDATE rooms SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return this.getRoom(id)!;
  }

  /** Removes the room and, by cascade, its participants, messages and turns. */
  deleteRoom(id: string): void {
    for (const message of this.listMessages(id)) this.dropDiffFiles(message.id, message.diffPath);
    // The whole folder, not one file per attachment: an upload the human never sent has no
    // row to find it by, and leaving those behind is how the config directory grows forever.
    rmSync(roomAttachmentsDir(id), { recursive: true, force: true });
    this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  }

  /**
   * A message can own two files under `diffs/`: the one this store spilled because the
   * diff did not fit in a row, and the one the engine wrote so a read-only reviewer could
   * read an oversized diff. They share the message id, so both go together.
   */
  private dropDiffFiles(messageId: string, recorded: string | null): void {
    if (recorded) rmSync(recorded, { force: true });
    const spill = diffFilePath(messageId);
    if (spill !== recorded) rmSync(spill, { force: true });
  }

  // --- participants --------------------------------------------------------

  addParticipant(input: AddParticipantInput): Participant {
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO participants (id, room_id, runtime, role, permission, model, session_id, order_index)
         VALUES (@id, @roomId, @runtime, @role, @permission, @model, @sessionId, @orderIndex)`,
      )
      .run({
        id,
        roomId: input.roomId,
        runtime: input.runtime,
        role: input.role,
        permission: input.permission,
        model: input.model ?? null,
        sessionId: input.sessionId ?? null,
        orderIndex: input.orderIndex,
      });
    return this.getParticipant(id)!;
  }

  getParticipant(id: string): Participant | undefined {
    const row = this.db.prepare('SELECT * FROM participants WHERE id = ?').get(id) as
      Row | undefined;
    return row ? toParticipant(row) : undefined;
  }

  listParticipants(roomId: string): Participant[] {
    return (
      this.db
        .prepare('SELECT * FROM participants WHERE room_id = ? ORDER BY order_index')
        .all(roomId) as Row[]
    ).map(toParticipant);
  }

  updateParticipant(
    id: string,
    patch: Partial<
      Pick<
        Participant,
        'sessionId' | 'lastSeenMessageId' | 'role' | 'permission' | 'model' | 'runtime'
      >
    >,
  ): Participant {
    const map: Record<string, string> = {
      sessionId: 'session_id',
      lastSeenMessageId: 'last_seen_message_id',
      role: 'role',
      permission: 'permission',
      model: 'model',
      runtime: 'runtime',
    };
    const sets: string[] = [];
    const params: Row = { id };
    for (const [key, column] of Object.entries(map)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = @${key}`);
      params[key] = (patch as Row)[key] ?? null;
    }
    if (sets.length === 0) return this.getParticipant(id)!;
    this.db.prepare(`UPDATE participants SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return this.getParticipant(id)!;
  }

  // --- messages ------------------------------------------------------------

  addMessage(input: AddMessageInput): Message {
    const id = input.id ?? randomUUID();
    const diff = input.diff ?? null;

    // Big diffs spill to a file so one enormous round cannot bloat the database.
    let inlineDiff: string | null = diff;
    let path: string | null = null;
    if (diff && Buffer.byteLength(diff, 'utf8') > MAX_INLINE_DIFF_BYTES) {
      path = diffFilePath(id);
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, diff);
        inlineDiff = null;
      } catch {
        // A read-only home must not lose the round. Keep it inline and pay the bytes.
        path = null;
        inlineDiff = diff;
      }
    }

    this.db
      .prepare(
        `INSERT INTO messages (id, room_id, participant_id, author, role, round, kind, text,
           verdict_json, activity_json, diff, diff_path, attachments_json, created_at)
         VALUES (@id, @roomId, @participantId, @author, @role, @round, @kind, @text,
           @verdictJson, @activityJson, @diff, @diffPath, @attachmentsJson, @createdAt)`,
      )
      .run({
        id,
        roomId: input.roomId,
        participantId: input.participantId ?? null,
        author: input.author,
        role: input.role ?? null,
        round: input.round ?? 0,
        kind: input.kind,
        text: input.text,
        verdictJson: input.verdict ? JSON.stringify(input.verdict) : null,
        activityJson: input.activity?.length ? JSON.stringify(input.activity) : null,
        diff: inlineDiff,
        diffPath: path,
        attachmentsJson: input.attachments?.length ? JSON.stringify(input.attachments) : null,
        createdAt: nowIso(),
      });
    return this.getMessage(id)!;
  }

  getMessage(id: string): Message | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return row ? toMessage(row) : undefined;
  }

  listMessages(roomId: string): Message[] {
    return (
      this.db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY seq').all(roomId) as Row[]
    ).map(toMessage);
  }

  /**
   * The messages a participant has not seen yet – exactly what
   * `buildTurnPrompt({ newMessages })` renders, and the reason that section only ever
   * carries the delta instead of the whole transcript.
   */
  messagesAfter(roomId: string, afterMessageId: string | null | undefined): Message[] {
    if (!afterMessageId) return this.listMessages(roomId);
    return (
      this.db
        .prepare(
          `SELECT * FROM messages
           WHERE room_id = ? AND seq > COALESCE((SELECT seq FROM messages WHERE id = ?), -1)
           ORDER BY seq`,
        )
        .all(roomId, afterMessageId) as Row[]
    ).map(toMessage);
  }

  latestMessageId(roomId: string): string | null {
    const row = this.db
      .prepare('SELECT id FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT 1')
      .get(roomId) as Row | undefined;
    return row ? asText(row.id) : null;
  }

  /** The full diff for a message, whether it lives in the row or in a spill file. */
  readDiff(message: Message): string | null {
    if (message.diff !== null) return message.diff;
    if (!message.diffPath) return null;
    try {
      return readFileSync(message.diffPath, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Roll a room back to the start of a round. Used by restart recovery: a turn that was
   * in flight when the process died cannot be reattached to, so the round is replayed.
   * Participants keep their runtime sessions, so only the turn is repeated, not the memory.
   */
  deleteMessagesFromRound(roomId: string, round: number): number {
    const doomed = this.db
      .prepare('SELECT * FROM messages WHERE room_id = ? AND round >= ? AND kind != ?')
      .all(roomId, round, 'user') as Row[];
    for (const row of doomed) this.dropDiffFiles(asText(row.id), str(row.diff_path));
    const info = this.db
      .prepare('DELETE FROM messages WHERE room_id = ? AND round >= ? AND kind != ?')
      .run(roomId, round, 'user');
    return info.changes;
  }

  // --- turns ---------------------------------------------------------------

  startTurn(input: StartTurnInput): TurnRecord {
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO turns (id, room_id, participant_id, round, role, permission, started_at, log_path)
         VALUES (@id, @roomId, @participantId, @round, @role, @permission, @startedAt, @logPath)`,
      )
      .run({
        id,
        roomId: input.roomId,
        participantId: input.participantId,
        round: input.round,
        role: input.role,
        permission: input.permission,
        startedAt: nowIso(),
        logPath: input.logPath ?? null,
      });
    return this.getTurn(id)!;
  }

  finishTurn(id: string, input: FinishTurnInput): TurnRecord {
    this.db
      .prepare(
        `UPDATE turns SET ended_at = @endedAt, ok = @ok, exit_code = @exitCode,
           error = @error, usage_json = @usageJson, session_id = @sessionId
         WHERE id = @id`,
      )
      .run({
        id,
        endedAt: nowIso(),
        ok: input.ok ? 1 : 0,
        exitCode: input.exitCode ?? null,
        error: input.error ?? null,
        usageJson: input.usage ? JSON.stringify(input.usage) : null,
        sessionId: input.sessionId ?? null,
      });
    return this.getTurn(id)!;
  }

  getTurn(id: string): TurnRecord | undefined {
    const row = this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as Row | undefined;
    return row ? toTurn(row) : undefined;
  }

  listTurns(roomId: string): TurnRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM turns WHERE room_id = ? ORDER BY started_at, rowid')
        .all(roomId) as Row[]
    ).map(toTurn);
  }

  /** Turns with no `ended_at`: after a restart, every one of these died with its parent. */
  unfinishedTurns(roomId: string): TurnRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM turns WHERE room_id = ? AND ended_at IS NULL ORDER BY started_at')
        .all(roomId) as Row[]
    ).map(toTurn);
  }

  /**
   * The most recent turn a participant took, whether it finished or not.
   *
   * The engine compares its `role` against the participant's current one: a participant
   * whose role was swapped between rounds is resuming a session that was told it was
   * something else, and Codex and Cursor only see role instructions on a session's first
   * prompt. This is how the engine knows to re-announce.
   */
  lastTurnFor(participantId: string): TurnRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM turns WHERE participant_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
      )
      .get(participantId) as Row | undefined;
    return row ? toTurn(row) : undefined;
  }

  // --- repos ---------------------------------------------------------------

  touchRepo(path: string, defaults?: Record<string, unknown> | null): void {
    this.db
      .prepare(
        `INSERT INTO repos (path, last_used_at, defaults_json) VALUES (@path, @lastUsedAt, @defaults)
         ON CONFLICT(path) DO UPDATE SET last_used_at = @lastUsedAt,
           defaults_json = COALESCE(@defaults, defaults_json)`,
      )
      .run({
        path,
        lastUsedAt: nowIso(),
        defaults: defaults ? JSON.stringify(defaults) : null,
      });
  }

  listRepos(limit = 20): RepoRecord[] {
    return (
      this.db.prepare('SELECT * FROM repos ORDER BY last_used_at DESC LIMIT ?').all(limit) as Row[]
    ).map((row) => ({
      path: asText(row.path),
      lastUsedAt: asText(row.last_used_at),
      defaults: parseJson<Record<string, unknown>>(row.defaults_json),
    }));
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    // A row written by a newer acr must not make an older one unable to list rooms.
    return null;
  }
}

/**
 * Additional folders, tolerating the bare strings written before access modes existed.
 *
 * A string is a folder from a room that predates the read/write distinction, and those
 * rooms could and did write to their extra folders, so a string reads back as `write`.
 */
function parseAdditionalDirs(value: unknown): AdditionalDir[] {
  const parsed = parseJson<unknown>(value);
  if (!Array.isArray(parsed)) return [];
  const dirs: AdditionalDir[] = [];
  for (const entry of parsed) {
    if (typeof entry === 'string') {
      dirs.push({ path: entry, access: 'write', branch: null, baseBranch: null, prUrl: null });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.path !== 'string' || !row.path) continue;
    dirs.push({
      path: row.path,
      access: row.access === 'read' ? 'read' : 'write',
      branch: typeof row.branch === 'string' ? row.branch : null,
      baseBranch: typeof row.baseBranch === 'string' ? row.baseBranch : null,
      prUrl: typeof row.prUrl === 'string' ? row.prUrl : null,
    });
  }
  return dirs;
}

/**
 * SQLite hands back `string | number | bigint | Buffer | null`, so every column read goes
 * through here rather than through a bare `String()` that would happily stringify a Buffer
 * into `[object Object]`.
 */
function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return null;
}

/** The same, for a column the schema declares NOT NULL. */
function asText(value: unknown): string {
  return str(value) ?? '';
}

function toRoom(row: Row): Room {
  return {
    id: asText(row.id),
    slug: asText(row.slug),
    title: asText(row.title),
    task: asText(row.task),
    mode: asText(row.mode) as RoomMode,
    repoRoot: asText(row.repo_root),
    additionalDirs: parseAdditionalDirs(row.additional_dirs_json),
    baseBranch: asText(row.base_branch),
    roomBranch: asText(row.room_branch),
    baseSha: str(row.base_sha),
    worktreePath: str(row.worktree_path),
    state: asText(row.state) as RoomState,
    paused: Number(row.paused ?? 0) === 1,
    nextSpeaker: str(row.next_speaker),
    round: Number(row.round),
    maxRounds: Number(row.max_rounds),
    maxTurnRetries: Number(row.max_turn_retries ?? 0),
    prUrl: str(row.pr_url),
    createdAt: asText(row.created_at),
    updatedAt: asText(row.updated_at),
    closedAt: str(row.closed_at),
  };
}

function toParticipant(row: Row): Participant {
  return {
    id: asText(row.id),
    roomId: asText(row.room_id),
    runtime: asText(row.runtime),
    role: asText(row.role) as Role,
    permission: asText(row.permission) as Permission,
    model: str(row.model),
    sessionId: str(row.session_id),
    orderIndex: Number(row.order_index),
    lastSeenMessageId: str(row.last_seen_message_id),
  };
}

function toMessage(row: Row): Message {
  return {
    id: asText(row.id),
    seq: Number(row.seq),
    roomId: asText(row.room_id),
    participantId: str(row.participant_id),
    author: asText(row.author),
    role: str(row.role),
    round: Number(row.round),
    kind: asText(row.kind) as MessageKind,
    text: asText(row.text),
    verdict: parseJson<Verdict>(row.verdict_json),
    activity: parseJson<TurnEvent[]>(row.activity_json) ?? [],
    diff: str(row.diff),
    diffPath: str(row.diff_path),
    attachments: parseJson<Attachment[]>(row.attachments_json) ?? [],
    createdAt: asText(row.created_at),
  };
}

function toTurn(row: Row): TurnRecord {
  return {
    id: asText(row.id),
    roomId: asText(row.room_id),
    participantId: asText(row.participant_id),
    round: Number(row.round),
    role: asText(row.role),
    permission: asText(row.permission) as Permission,
    startedAt: asText(row.started_at),
    endedAt: str(row.ended_at),
    ok: row.ok === null || row.ok === undefined ? null : Number(row.ok) === 1,
    exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
    error: str(row.error),
    usage: parseJson<Usage>(row.usage_json),
    sessionId: str(row.session_id),
    logPath: str(row.log_path),
  };
}
