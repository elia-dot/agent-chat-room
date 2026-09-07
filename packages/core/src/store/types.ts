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

/**
 * What a room may do with an extra workspace root.
 *
 * `read` is context only: the agents can open the files, and the room reverts anything they
 * change there. `write` makes the folder part of the room – its changes join the diff the
 * reviewers judge, the room commits them on a branch of its own, and "Open PR" opens one
 * there too.
 */
export type AdditionalDirAccess = 'read' | 'write';

export interface AdditionalDir {
  /** Absolute, canonical path. */
  path: string;
  access: AdditionalDirAccess;
  /**
   * Branch the room cut in that repository to hold its commits, and the branch it was cut
   * from. Both null until the room first commits there, so a folder nobody touched is left
   * exactly as it was found.
   */
  branch: string | null;
  baseBranch: string | null;
  /** The pull request "Open PR" opened in that repository. */
  prUrl: string | null;
}

export interface Room {
  id: string;
  slug: string;
  title: string;
  task: string;
  mode: RoomMode;
  /** The human's checkout. Turns run in `worktreePath` when the room has one. */
  repoRoot: string;
  /** Extra absolute workspace roots granted to every runtime in this room. */
  additionalDirs: AdditionalDir[];
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
  /** The fixed phase count of a brainstorm. A build-review room has no limit and stores 0. */
  maxRounds: number;
  /**
   * How many times a failed turn is retried before the room stops and asks the human.
   * `0` – the default – is the original behaviour: one failure hands the room over.
   * The room owner sets this, and may change it while the room is open.
   */
  maxTurnRetries: number;
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

/**
 * What an attachment is for, which is the only thing the prompt and the transcript render
 * differently. `room` is a snapshot of another room's transcript, taken when it was
 * referenced, so re-reading it later cannot show a conversation that moved on since.
 */
export type AttachmentKind = 'image' | 'doc' | 'room';

/** A file the human put into the chat, and that the agents are told to read. */
export interface Attachment {
  /** Server-minted uuid. Also the stem of the file on disk. */
  id: string;
  /** The original filename, for the human. Never used to build a path. */
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  /** Absolute path on the machine running the server. This is what the agents open. */
  path: string;
  /** Set on a `room` attachment: which room the transcript came from. */
  roomRef?: { id: string; slug: string; title: string };
}

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
  /** Files the human attached to this message. Empty for everything an agent writes. */
  attachments: Attachment[];
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
