import type { Role } from '../roles.js';
import type { Permission, TurnEvent, Usage } from '../types.js';
import type { Verdict } from '../verdict.js';

/**
 * The persisted shapes behind `RoomStore`. Column names are snake_case in SQLite and
 * camelCase here; `rooms.ts` is the only file that knows about the translation.
 */

/** PLAN.md section 4.2: `idle → running(turn) → waiting-reviews → needs-you | approved | stopped`. */
export type RoomState =
  'idle' | 'running' | 'waiting-reviews' | 'approved' | 'needs-you' | 'stopped';

/**
 * `build-review` is the loop from PLAN.md section 3; `brainstorm` is the three-phase
 * discussion below it – everybody answers, everybody reacts, the moderator merges.
 */
export type RoomMode = 'build-review' | 'brainstorm';

export interface Room {
  id: string;
  slug: string;
  title: string;
  task: string;
  mode: RoomMode;
  /** The human's checkout. Turns run in `worktreePath` when the room has one. */
  repoRoot: string;
  /** The branch the checkout was on when the room opened. */
  baseBranch: string;
  /** `acr/<slug>`. */
  roomBranch: string;
  /** HEAD when the room opened. Every diff in the room is taken against this. */
  baseSha: string | null;
  worktreePath: string | null;
  state: RoomState;
  /**
   * The human asked the loop to hold. Orthogonal to `state`: a paused room sits in `idle`,
   * which is also where restart recovery leaves a room, and this column is what tells the
   * two apart.
   */
  paused: boolean;
  /** Runtime id the next turn is routed to, set by an `@mention`. Null means "the worker". */
  nextSpeaker: string | null;
  round: number;
  maxRounds: number;
  /** The pull request "Open PR" created, kept so it survives a reload. */
  prUrl: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Participant {
  id: string;
  roomId: string;
  runtime: string;
  role: Role;
  permission: Permission;
  model: string | null;
  /** The runtime's own session id, threaded into the next turn's resume flag. */
  sessionId: string | null;
  orderIndex: number;
  /** Everything after this message is what the next turn's prompt carries. */
  lastSeenMessageId: string | null;
}

export type MessageKind = 'user' | 'agent' | 'system';

export interface Message {
  id: string;
  /** Monotonic within the database. The transcript's true order. */
  seq: number;
  roomId: string;
  participantId: string | null;
  author: string;
  role: string | null;
  round: number;
  kind: MessageKind;
  text: string;
  verdict: Verdict | null;
  /** The collapsed tool log: the `tool` and `file` events the turn produced. */
  activity: TurnEvent[];
  /** Inline for diffs under `MAX_INLINE_DIFF_BYTES`; otherwise see `diffPath`. */
  diff: string | null;
  diffPath: string | null;
  createdAt: string;
}

export interface TurnRecord {
  id: string;
  roomId: string;
  participantId: string;
  round: number;
  role: string;
  permission: Permission;
  startedAt: string;
  /** Null while the turn is in flight – which, after a restart, means it was interrupted. */
  endedAt: string | null;
  ok: boolean | null;
  exitCode: number | null;
  error: string | null;
  usage: Usage | null;
  sessionId: string | null;
  logPath: string | null;
}

export interface RepoRecord {
  path: string;
  lastUsedAt: string;
  defaults: Record<string, unknown> | null;
}
