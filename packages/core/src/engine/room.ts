import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, mkdirSync, writeFileSync } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';

import { adapters as defaultAdapters } from '../adapters/index.js';
import type { LoadedRepoConfig } from '../config.js';
import { loadRepoConfig, resolveRoomDefaults } from '../config.js';
import type { CreatePrResult, GhRunner } from '../gh.js';
import { createPr, detectGh } from '../gh.js';
import * as git from '../git.js';
import { diffPath as diffSpillPath, turnLogPath } from '../paths.js';
import { canWrite } from '../permissions.js';
import { killProcessTree } from '../process/runTurn.js';
import type { PromptMessage } from '../prompt.js';
import { DEFAULT_MAX_INLINE_DIFF_BYTES, buildTurnPrompt } from '../prompt.js';
import type { BrainstormPhase, Role } from '../roles.js';
import { roleInstructions } from '../roles.js';
import type { RoomStore } from '../store/rooms.js';
import type { Message, Participant, Room, RoomMode, RoomState } from '../store/types.js';
import type { AgentAdapter, Permission, TurnResult } from '../types.js';
import type { ParsedVerdict, Verdict } from '../verdict.js';
import { enforceGoalposts, parseVerdict, verdictJsonSchema } from '../verdict.js';
import {
  branchFor,
  createWorktree,
  ensureWorktree,
  removeWorktree,
  uniqueSlug,
} from '../worktree.js';
import type { EngineEvent, EngineEventSink } from './events.js';
import { TurnStream } from './events.js';
import type { AcquireLockOptions, LockHandle } from './lock.js';
import { acquireRepoLock, acquireRoomLock } from './lock.js';
import { assertTransition, isTerminal } from './state.js';

/** Something the human did wrong, or something about the repo the engine will not guess at. */
export class EngineError extends Error {}

export interface RoomEngineOptions {
  store: RoomStore;
  /** Defaults to the built-in registry. Injectable so tests can supply fakes. */
  adapters?: Record<string, AgentAdapter>;
  /** Per-turn stall timeout. */
  timeoutMs?: number;
  lock?: AcquireLockOptions;
}

export interface CreateRoomInput {
  task: string;
  cwd: string;
  /** Extra absolute workspace roots granted to every runtime in the room. */
  additionalDirs?: string[];
  /** Runtime ids. The first is the worker, every other one reviews. */
  agents: string[];
  title?: string;
  mode?: RoomMode;
  /** Run in a dedicated git worktree (default). `false` works in the checkout itself. */
  worktree?: boolean;
  /** Per-runtime model override, e.g. `{ claude: 'opus' }`. */
  models?: Record<string, string>;
  /** Model for the worker, whichever runtime the resolved roster puts first. */
  modelWorker?: string;
  /** Model for every reviewer. */
  modelReviewer?: string;
  workerPermission?: Permission;
  reviewerPermission?: Permission;
  /** Only meaningful with `worktree: false`; a worktree starts clean by construction. */
  allowDirty?: boolean;
}

export interface RoomOutcome {
  roomId: string;
  state: RoomState;
  mode: RoomMode;
  round: number;
  approved: boolean;
  /** The loop stopped because the human held it, not because the room is finished. */
  paused: boolean;
  /** Set when a turn failed, as opposed to the room simply not being approved. */
  error?: string;
  /** Short sha of the commit the approved round produced. */
  commit?: string;
  changedFiles: string[];
}

export const MAX_ADDITIONAL_DIRS = 20;

/** Validate and canonicalise workspace roots before they reach a CLI argument list. */
export async function validateAdditionalDirs(paths: readonly string[]): Promise<string[]> {
  if (paths.length > MAX_ADDITIONAL_DIRS) {
    throw new EngineError(`a room can grant at most ${MAX_ADDITIONAL_DIRS} additional folders`);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const path = raw.trim();
    if (!path) continue;
    if (!isAbsolute(path)) throw new EngineError(`additional folder must be absolute: "${path}"`);

    let canonical: string;
    try {
      canonical = await realpath(path);
      if (!(await stat(canonical)).isDirectory()) {
        throw new EngineError(`additional path is not a folder: "${path}"`);
      }
      await access(canonical, constants.R_OK | constants.X_OK);
    } catch (err) {
      if (err instanceof EngineError) throw err;
      throw new EngineError(`additional folder does not exist or cannot be read: "${path}"`);
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      result.push(canonical);
    }
  }
  return result;
}

export interface RunOptions {
  /**
   * Run exactly one turn, by this runtime, instead of the round loop. This is the
   * "the next turn is whoever you @mention" rule from PLAN.md section 3: the room lands
   * back in `idle` afterwards and the human decides what happens next.
   */
  directTurn?: string;
}

export interface PostUserMessageOptions {
  /** Runtime id from the room's roster. Defaults to the worker. */
  mention?: string;
}

interface ReviewOutcome {
  participant: Participant;
  result: TurnResult;
  message: Message;
  verdict: ParsedVerdict;
}

const DEFAULT_TIMEOUT_MS = 1800_000;

/**
 * Brainstorm mode is exactly three rounds (PLAN.md section 3): answer, react, merge. It is
 * a fixed shape, so `maxRounds` on a brainstorm room is this. A build-review room has no
 * round limit at all – it runs until every reviewer approves, someone asks you a question,
 * or you pause or stop it – and stores `0` there.
 */
export const BRAINSTORM_ROUNDS = 3;

const BRAINSTORM_PHASES: Record<number, BrainstormPhase> = {
  1: 'answer',
  2: 'react',
  3: 'merge',
};

/** How long to wait for another process's room lock before giving up. */
const ROOM_LOCK_TIMEOUT_MS = 2000;

/**
 * The roster rules, in one place, checked on creation *and* on every edit.
 *
 * The single-writer rule (PLAN.md section 3) is the one invariant that protects the
 * human's repo, so it is checked against the roster rather than trusted from the flag
 * mapping – and a role swap has to go through the same gate a fresh room does.
 */
export function assertRoster(
  participants: { runtime: string; role: Role; permission: Permission }[],
  mode: RoomMode,
): void {
  if (mode === 'brainstorm') {
    const moderators = participants.filter((p) => p.role === 'moderator');
    if (moderators.length !== 1) {
      throw new EngineError(
        `a brainstorm room needs exactly one moderator, got ${moderators.length}`,
      );
    }
    const writer = participants.find((p) => canWrite(p.permission));
    if (writer) {
      throw new EngineError(
        `nobody edits in a brainstorm room – ${writer.runtime} has "${writer.permission}"`,
      );
    }
    const stray = participants.find((p) => p.role !== 'moderator' && p.role !== 'reviewer');
    if (stray) {
      throw new EngineError(
        `a brainstorm room has no "${stray.role}" – only reviewers and one moderator`,
      );
    }
    return;
  }

  const workers = participants.filter((p) => p.role === 'worker');
  if (workers.length !== 1) {
    throw new EngineError(`a build-review room needs exactly one worker, got ${workers.length}`);
  }
  const worker = workers[0]!;
  if (!canWrite(worker.permission)) {
    throw new EngineError(`the worker needs a writing permission, got "${worker.permission}"`);
  }
  const reviewers = participants.filter((p) => p.role !== 'worker');
  if (reviewers.length === 0) {
    throw new EngineError(
      `a build-review room needs a worker and at least one reviewer, e.g. --agents claude,codex`,
    );
  }
  for (const reviewer of reviewers) {
    if (reviewer.role !== 'reviewer') {
      throw new EngineError(
        `a build-review room has no "${reviewer.role}" – only worker and reviewers`,
      );
    }
    if (canWrite(reviewer.permission)) {
      throw new EngineError(
        `reviewers must be read-only – only the worker may edit (${reviewer.runtime} has "${reviewer.permission}")`,
      );
    }
  }
}

/**
 * The room engine: the round loop from PLAN.md section 3, persisted after every transition.
 *
 * The loop itself is small – worker writes, reviewers read, tally, repeat – and almost all
 * of the code here is about the two things that make it survivable: every state change
 * lands in SQLite before the next thing happens, and every writing turn holds the repo's
 * write lock. Together those are what let `RoomEngine.load()` pick a room back up after
 * the process that was running it died mid-turn.
 */
export class RoomEngine {
  private roomRow: Room;
  private readonly store: RoomStore;
  private readonly registry: Record<string, AgentAdapter>;
  private readonly timeoutMs: number;
  private readonly lockOptions: AcquireLockOptions;
  private readonly listeners = new Set<EngineEventSink>();
  private readonly active = new Set<{ cancel(reason?: string): void }>();
  private stopping = false;
  private stopReason: string | undefined;
  private activeCommandCancel?: (reason?: string) => void;
  private readonly repoConfig: LoadedRepoConfig;
  /** Files the most recent round touched, for the outcome and the CLI's summary. */
  private lastChangedFiles: string[] = [];

  /** Non-fatal `.acr.json` complaints, surfaced by the caller rather than thrown. */
  readonly configWarnings: string[];

  private constructor(room: Room, opts: RoomEngineOptions, repoConfig: LoadedRepoConfig) {
    this.configWarnings = repoConfig.warnings;
    this.repoConfig = repoConfig;
    this.roomRow = room;
    this.store = opts.store;
    this.registry = opts.adapters ?? defaultAdapters;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.lockOptions = opts.lock ?? {};
  }

  get room(): Room {
    return this.roomRow;
  }

  get participants(): Participant[] {
    return this.store.listParticipants(this.roomRow.id);
  }

  get messages(): Message[] {
    return this.store.listMessages(this.roomRow.id);
  }

  /**
   * Re-read the room row. A long-lived engine caches it, so anything that edits the row
   * from outside – the server renaming the room, say – has to say so.
   */
  reload(): Room {
    const row = this.store.getRoom(this.roomRow.id);
    if (row) this.roomRow = row;
    return this.roomRow;
  }

  /** Subscribe to the engine event stream. Returns an unsubscribe function. */
  subscribe(listener: EngineEventSink): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- construction --------------------------------------------------------

  /**
   * Open a room: resolve the repo, create the worktree, write the roster, and post the
   * task as the first message. Nothing runs yet – call `run()` for that.
   */
  static async create(input: CreateRoomInput, opts: RoomEngineOptions): Promise<RoomEngine> {
    const repoRoot = await git.repoRoot(input.cwd);
    if (!repoRoot) {
      throw new EngineError(
        `${input.cwd} is not inside a git repository. A room needs one: the diff, the branch and the worktree all come from git.`,
      );
    }

    const task = input.task.trim();
    if (!task) throw new EngineError('a room needs a task');

    // Precedence: whatever the caller passed > `.acr.json` in the repo > built-in defaults.
    const repoConfig = loadRepoConfig(repoRoot);
    const settings = resolveRoomDefaults(repoConfig.config, {
      ...(input.agents.length > 0 ? { agents: input.agents } : {}),
      ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
      ...(input.models ? { models: input.models } : {}),
      ...(input.additionalDirs ? { additional_dirs: input.additionalDirs } : {}),
    });
    const additionalDirs = await validateAdditionalDirs(settings.additional_dirs ?? []);

    const mode: RoomMode = input.mode ?? 'build-review';
    const registry = opts.adapters ?? defaultAdapters;
    for (const id of settings.agents) {
      if (!registry[id]) {
        throw new EngineError(
          `unknown runtime "${id}". Run \`acr doctor\` to see what acr knows about.`,
        );
      }
    }

    const workerPermission = input.workerPermission ?? settings.workerPermission;
    const reviewerPermission = input.reviewerPermission ?? settings.reviewerPermission;

    // The roster, as rows, before anything is written: `assertRoster` is the gate both
    // creation and `setParticipant` go through, so the rules cannot be true of one and not
    // the other. In a brainstorm the *last* runtime moderates (the first builds in a
    // build-review room, and the moderator is the one who speaks last).
    const roster = settings.agents.map((runtime, index) => {
      const brainstormModerator = mode === 'brainstorm' && index === settings.agents.length - 1;
      const role: Role = brainstormModerator
        ? 'moderator'
        : mode === 'brainstorm' || index > 0
          ? 'reviewer'
          : 'worker';
      return {
        runtime,
        role,
        permission:
          mode === 'brainstorm' || role !== 'worker' ? reviewerPermission : workerPermission,
        model:
          (role === 'worker' ? input.modelWorker : input.modelReviewer) ??
          settings.models[runtime] ??
          null,
      };
    });
    if (settings.agents.length < 2) {
      throw new EngineError(
        mode === 'brainstorm'
          ? 'a brainstorm room needs at least two participants, e.g. --agents claude,codex'
          : 'a build-review room needs a worker and at least one reviewer, e.g. --agents claude,codex',
      );
    }
    assertRoster(roster, mode);

    const baseBranch = await git.currentBranch(repoRoot);
    const title = input.title?.trim() || deriveTitle(task, repoRoot);
    const useWorktree = settings.worktree;
    const roomId = randomUUID();

    let roomBranch = baseBranch;
    let worktreePath: string | null = null;
    let baseSha = (await git.headSha(repoRoot)) ?? null;

    if (useWorktree) {
      const slug = await uniqueSlug(repoRoot, title, roomId.replace(/-/g, ''));
      roomBranch = branchFor(slug);
      const worktree = await createWorktree({ repoRoot, roomId, branch: roomBranch });
      worktreePath = worktree.path;
      baseSha = worktree.baseSha ?? baseSha;
    } else if (!input.allowDirty && (await git.isDirty(repoRoot))) {
      // Without a worktree the worker edits the checkout you are standing in, so a dirty
      // tree would make the room's diff unattributable. This is the M0 behaviour, kept as
      // an escape hatch for repos where worktrees misbehave (submodules, some tooling).
      throw new EngineError(
        `${repoRoot} has uncommitted changes. Commit or stash them, drop --no-worktree, or pass --allow-dirty.`,
      );
    }

    const slug = roomBranch.startsWith('acr/') ? roomBranch.slice(4) : baseBranch;
    const room = opts.store.createRoom({
      id: roomId,
      slug,
      title,
      task,
      mode,
      repoRoot,
      additionalDirs,
      baseBranch,
      roomBranch,
      baseSha,
      worktreePath,
      // A brainstorm is three fixed phases; a build loop has no budget at all.
      maxRounds: mode === 'brainstorm' ? BRAINSTORM_ROUNDS : 0,
    });

    roster.forEach((participant, index) => {
      opts.store.addParticipant({ roomId: room.id, ...participant, orderIndex: index });
    });

    opts.store.touchRepo(repoRoot, repoConfig.config);
    opts.store.addMessage({
      roomId: room.id,
      author: 'you',
      role: 'owner',
      kind: 'user',
      round: 0,
      text: task,
    });

    const engine = new RoomEngine(
      room,
      { ...opts, timeoutMs: opts.timeoutMs ?? settings.timeoutSeconds * 1000 },
      repoConfig,
    );

    return engine;
  }

  /**
   * Pick up an existing room, repairing whatever the last process left behind.
   *
   * A turn with no `ended_at` belonged to a child that died with its parent, and there is
   * no way to reattach to it. So it is marked, the round it belonged to is rolled back,
   * and the round re-runs. The runtime session ids live on the participants, so each agent
   * still remembers the room – only the one turn is repeated, not the conversation.
   */
  static async load(idOrPrefix: string, opts: RoomEngineOptions): Promise<RoomEngine> {
    const room = opts.store.findRoom(idOrPrefix);
    if (!room) throw new EngineError(`no room matches "${idOrPrefix}"`);
    const repoConfig = loadRepoConfig(room.repoRoot);
    const settings = resolveRoomDefaults(repoConfig.config);
    const engine = new RoomEngine(
      room,
      { ...opts, timeoutMs: opts.timeoutMs ?? settings.timeoutSeconds * 1000 },
      repoConfig,
    );
    await engine.recover();
    return engine;
  }

  private async recover(): Promise<void> {
    const room = this.roomRow;

    if (room.worktreePath && !room.closedAt) {
      await ensureWorktree({
        repoRoot: room.repoRoot,
        path: room.worktreePath,
        branch: room.roomBranch,
      });
    }

    const unfinished = this.store.unfinishedTurns(room.id);
    const midFlight = room.state === 'running' || room.state === 'waiting-reviews';
    if (unfinished.length === 0 && !midFlight) return;

    const rounds = unfinished.map((t) => t.round);
    const round = rounds.length > 0 ? Math.min(...rounds) : Math.max(room.round, 1);

    for (const turn of unfinished) {
      this.store.finishTurn(turn.id, {
        ok: false,
        error: 'interrupted by process exit',
        exitCode: null,
      });
    }

    this.store.deleteMessagesFromRound(room.id, round);
    this.roomRow = this.store.updateRoom(room.id, { round: round - 1, state: 'idle' });
    this.system(
      `round ${round} was interrupted when the previous acr process exited; it will run again.`,
      round,
    );
  }

  // --- the loop ------------------------------------------------------------

  /**
   * Run rounds until the room approves, needs the human, is paused, or is stopped.
   *
   * The whole loop runs under the room lock. The per-repo write lock stops two engines
   * corrupting one working tree; it does nothing about two engines writing state for the
   * same room, which is what happens when a terminal `acr run --room X` is pointed at a
   * room the server is already driving. That fails fast here instead of interleaving.
   */
  async run(opts: RunOptions = {}): Promise<RoomOutcome> {
    if (this.roomRow.state === 'approved') return this.outcome();

    const roomLock = await acquireRoomLock(this.roomRow.id, {
      timeoutMs: ROOM_LOCK_TIMEOUT_MS,
      pollMs: 100,
    }).catch((err: unknown) => {
      throw new EngineError(
        `${err instanceof Error ? err.message : String(err)}. Another acr process is driving this room; stop it, or use that one.`,
      );
    });

    try {
      return await this.runLocked(opts);
    } finally {
      roomLock.release();
    }
  }

  private async runLocked(opts: RunOptions): Promise<RoomOutcome> {
    this.stopping = false;
    this.stopReason = undefined;
    if (!(await this.ensureSetup())) return this.outcome({});
    if (opts.directTurn) return await this.runDirectTurn(opts.directTurn);
    if (this.roomRow.mode === 'brainstorm') return await this.runBrainstormRounds();

    let lastError: string | undefined;
    let commit: string | undefined;

    for (;;) {
      if (this.stopping) {
        this.setState('stopped');
        break;
      }
      if (this.roomRow.paused) {
        // Checked at the top of a round rather than mid-turn: killing a running worker
        // would throw away the diff it is half way through writing, and `stop()` is
        // already there for the human who really means it.
        this.settle();
        break;
      }
      const round = this.roomRow.round + 1;

      let lock: LockHandle;
      try {
        lock = await this.acquireLock();
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.system(`could not take the write lock: ${lastError}`, round);
        this.setState('needs-you');
        break;
      }

      let result: { done: boolean; error?: string; commit?: string };
      try {
        result = await this.runRound(round);
      } finally {
        lock.release();
      }

      if (result.error) lastError = result.error;
      if (result.commit) commit = result.commit;
      if (result.done) break;
    }

    return this.outcome({
      ...(lastError ? { error: lastError } : {}),
      ...(commit ? { commit } : {}),
    });
  }

  /** Ask the running turns to stop. The room lands in `stopped` once they settle. */
  stop(reason = 'stopped by request'): void {
    this.stopping = true;
    this.stopReason = reason;
    if (this.activeCommandCancel) {
      this.activeCommandCancel(reason);
      this.activeCommandCancel = undefined;
    }
    for (const handle of this.active) handle.cancel(reason);
  }

  /**
   * Hold the loop. The turn that is already in flight finishes – its diff is real work –
   * and no further round starts. The room lands in `idle`, which is resumable.
   */
  pause(reason = 'paused'): Room {
    if (!this.roomRow.paused) {
      this.roomRow = this.store.updateRoom(this.roomRow.id, { paused: true });
      this.emit({ type: 'room.paused', roomId: this.roomRow.id, paused: true });
      this.system(reason);
    }
    return this.roomRow;
  }

  /** Clear the hold. Nothing runs until the caller calls `run()`. */
  resume(): Room {
    if (this.roomRow.paused) {
      this.roomRow = this.store.updateRoom(this.roomRow.id, { paused: false });
      this.emit({ type: 'room.paused', roomId: this.roomRow.id, paused: false });
    }
    return this.roomRow;
  }

  /**
   * Post a message from the human into the room and hold the loop so they can decide who
   * answers (PLAN.md section 3: "You can interrupt any time").
   *
   * Nothing has to be threaded into a prompt here: every participant carries a
   * `lastSeenMessageId`, so `unseenFor` picks this message up on the next turn for free.
   */
  postUserMessage(text: string, opts: PostUserMessageOptions = {}): Message {
    const body = text.trim();
    if (!body) throw new EngineError('a message needs some text');

    const roster = this.participants;
    const defaultTarget =
      this.roomRow.mode === 'brainstorm'
        ? roster.find((participant) => participant.role === 'moderator')
        : roster.find((participant) => participant.role === 'worker');
    if (!defaultTarget) {
      throw new EngineError(
        this.roomRow.mode === 'brainstorm'
          ? 'this brainstorm room has no moderator'
          : `room ${this.roomRow.id} has no worker participant`,
      );
    }
    let next = defaultTarget.runtime;
    if (opts.mention) {
      const target = roster.find((p) => p.runtime === opts.mention);
      if (!target) {
        throw new EngineError(
          `nobody called "${opts.mention}" is in this room. Try: ${roster
            .map((p) => `@${p.runtime}`)
            .join(', ')}`,
        );
      }
      next = target.runtime;
    }

    const message = this.store.addMessage({
      roomId: this.roomRow.id,
      author: 'you',
      role: 'owner',
      kind: 'user',
      round: this.roomRow.round,
      text: body,
    });
    this.emit({ type: 'message.done', roomId: this.roomRow.id, message });

    // Interrupting means the human is steering, so the loop holds rather than racing them
    // to the next round. Continuing is one click, and it is theirs to make.
    this.roomRow = this.store.updateRoom(this.roomRow.id, { paused: true, nextSpeaker: next });
    this.emit({ type: 'room.paused', roomId: this.roomRow.id, paused: true });
    return message;
  }

  /**
   * One turn by one named participant, outside the round loop. A worker's turn still
   * takes the write lock and still captures a diff; a reviewer's does neither, because a
   * read-only turn changes nothing there is a diff of.
   */
  private async runDirectTurn(runtime: string): Promise<RoomOutcome> {
    const participant = this.participants.find((p) => p.runtime === runtime);
    if (!participant) {
      throw new EngineError(`nobody called "${runtime}" is in this room`);
    }

    // A direct turn is a side conversation, not a review cycle, so it does not consume a
    // round. Round 0 only happens before the loop has run at all.
    const round = Math.max(this.roomRow.round, 1);
    this.roomRow = this.store.updateRoom(this.roomRow.id, { round, nextSpeaker: null });
    this.setState('running');

    const cwd = this.workdir();
    const writes = canWrite(participant.permission);
    const diffStat = await git.diffStat(cwd, this.baseSha());
    const diff = writes ? '' : await git.diffSince(cwd, this.baseSha());

    const lock = writes ? await this.acquireLock() : undefined;
    let turn: { result: TurnResult; stream: TurnStream; messageId: string };
    try {
      turn = await this.runParticipantTurn(participant, {
        round,
        cwd,
        diffStat,
        ...(diff ? { diff } : {}),
      });
    } finally {
      lock?.release();
    }

    let error: string | undefined;
    if (turn.result.ok) {
      const captured = writes ? await git.diffSince(cwd, this.baseSha()) : null;
      if (writes) this.lastChangedFiles = await git.changedFiles(cwd, this.baseSha());
      const verdict =
        participant.role === 'reviewer'
          ? parseVerdict(turn.result.text, turn.result.structured)
          : null;
      this.postTurnMessage(
        participant,
        turn,
        round,
        captured,
        verdict?.ok ? verdict.verdict : null,
      );
    } else {
      error = turn.result.error ?? `${runtime}'s turn failed`;
      this.system(`${runtime}'s turn failed: ${error}`, round);
    }

    // A moderator's direct brainstorm turn is a revised proposal, not a side conversation.
    // Keep the room at its successful handoff state so Promote uses the newest proposal.
    if (this.roomRow.mode === 'brainstorm' && participant.role === 'moderator') {
      if (!error) {
        this.system('the moderator has revised the proposal. Accept it, or promote it.', round);
      }
      this.setState('needs-you');
    } else {
      this.settle();
    }
    return this.outcome(error ? { error } : {});
  }

  /**
   * Where a held or single-turn room comes to rest. `idle` is the only non-terminal state
   * that means "nothing is running"; a room the tally already sent somewhere terminal keeps
   * that answer.
   */
  private settle(): void {
    if (isTerminal(this.roomRow.state)) return;
    this.setState('idle');
  }

  /** Remove the worktree and mark the room closed. The branch is left alone. */
  async close(): Promise<void> {
    const room = this.roomRow;
    if (room.worktreePath) {
      await removeWorktree(room.repoRoot, room.worktreePath);
    }
    if (!isTerminal(room.state)) this.setState('stopped');
    this.roomRow = this.store.updateRoom(room.id, {
      closedAt: new Date().toISOString(),
      worktreePath: null,
    });
  }

  // --- brainstorm ----------------------------------------------------------

  /**
   * The three phases from PLAN.md section 3, mapped onto the round counter so the store,
   * the state machine, the WebSocket and the transcript all keep working unchanged:
   *
   *   round 1  everyone answers, in parallel, read-only
   *   round 2  everyone reacts to the others' answers
   *   round 3  the moderator writes the merged proposal
   *
   * Nobody edits, so there is no write lock to take, no diff to capture, no round to commit
   * and no verdict to parse. The room ends in `needs-you` with a proposal – for a
   * brainstorm that is success, not a stall.
   */
  private async runBrainstormRounds(): Promise<RoomOutcome> {
    let lastError: string | undefined;

    for (;;) {
      if (this.stopping) {
        this.setState('stopped');
        break;
      }
      if (this.roomRow.paused) {
        this.settle();
        break;
      }
      const round = this.roomRow.round + 1;
      if (round > BRAINSTORM_ROUNDS) {
        this.system('this brainstorm has already finished all three phases.');
        this.setState('needs-you');
        break;
      }

      const result = await this.runBrainstormRound(round);
      if (result.error) lastError = result.error;
      if (result.done) break;
    }

    return this.outcome(lastError ? { error: lastError } : {});
  }

  private async runBrainstormRound(round: number): Promise<{ done: boolean; error?: string }> {
    const phase = BRAINSTORM_PHASES[round] ?? 'merge';
    this.roomRow = this.store.updateRoom(this.roomRow.id, { round });
    // A brainstorm stays in `running` for all three rounds, so `setState` – which is a
    // no-op on an unchanged state – would only announce the first one. Everything that
    // renders round boundaries reads `room.state`, so each round says so itself.
    const stateChanges = this.roomRow.state !== 'running';
    this.setState('running');
    if (!stateChanges) {
      this.emit({ type: 'room.state', roomId: this.roomRow.id, state: 'running', round });
    }

    const roster = this.participants;
    const speakers = phase === 'merge' ? roster.filter((p) => p.role === 'moderator') : roster;
    if (speakers.length === 0) {
      const error = 'this brainstorm room has no moderator to write the proposal';
      this.system(error, round);
      this.setState('needs-you');
      return { done: true, error };
    }

    this.system(
      phase === 'answer'
        ? `round 1: everyone answers, in parallel and read-only.`
        : phase === 'react'
          ? `round 2: everyone reacts to the other answers.`
          : `round 3: ${speakers[0]!.runtime} writes the merged proposal.`,
      round,
    );

    const cwd = this.workdir();
    // Every speaker's unseen list is computed before any turn runs, so a round-1 answer
    // cannot leak into another round-1 prompt just because it finished first.
    const requests = speakers.map((participant) => ({
      participant,
      newMessages: this.unseenFor(participant),
      watermark: this.store.latestMessageId(this.roomRow.id),
    }));

    const results = await Promise.all(
      requests.map(async ({ participant, newMessages, watermark }) => {
        const turn = await this.runParticipantTurn(participant, {
          round,
          cwd,
          phase,
          newMessages,
          watermark,
        });
        if (turn.result.ok) this.postTurnMessage(participant, turn, round, null);
        return { participant, result: turn.result };
      }),
    );

    const failed = results.filter((r) => !r.result.ok);
    for (const { participant, result } of failed) {
      this.system(
        `${participant.runtime}'s turn failed: ${result.error ?? 'unknown error'}`,
        round,
      );
    }

    if (this.stopping) {
      this.setState('stopped');
      return { done: true };
    }
    if (failed.length === results.length) {
      const error = failed[0]?.result.error ?? 'every turn in this round failed';
      this.setState('needs-you');
      return { done: true, error };
    }

    if (phase === 'merge') {
      this.system('the moderator has proposed. Accept it, or promote it into a build room.', round);
      this.setState('needs-you');
      return { done: true };
    }
    return { done: false };
  }

  /** The moderator's merged proposal, or undefined while the room has not produced one. */
  proposal(): Message | undefined {
    const moderators = new Set(
      this.participants.filter((p) => p.role === 'moderator').map((p) => p.id),
    );
    const written = this.messages.filter(
      (m) => m.kind === 'agent' && m.participantId !== null && moderators.has(m.participantId),
    );
    return written[written.length - 1];
  }

  // --- roster, commit and PR ------------------------------------------------

  /**
   * Change one participant's role or model mid-room (PLAN.md section 3: "swap roles between
   * rounds without losing sessions").
   *
   * Refused while a turn is in flight: the permission a child was spawned with is baked into
   * that process, so a swap mid-turn would be a lie. Promoting a reviewer *swaps* – the old
   * worker drops to reviewer in the same call – so the single-writer rule is never briefly
   * violated. Sessions are kept, which is the whole point; `runParticipantTurn` re-announces
   * the new role in the next prompt, because Codex and Cursor only see role instructions on
   * a session's first turn.
   */
  setParticipant(runtime: string, patch: { role?: Role; model?: string | null }): Participant[] {
    const room = this.reload();
    if (room.state === 'running' || room.state === 'waiting-reviews') {
      throw new EngineError(
        `${runtime} is mid-round. Pause or stop the room before changing the roster.`,
      );
    }

    const roster = this.participants;
    const target = roster.find((p) => p.runtime === runtime);
    if (!target) {
      throw new EngineError(
        `nobody called "${runtime}" is in this room. Try: ${roster.map((p) => p.runtime).join(', ')}`,
      );
    }
    if (patch.role === undefined && patch.model === undefined) {
      throw new EngineError('nothing to change: pass a role, a model, or both');
    }

    const workerPermission = roster.find((p) => p.role === 'worker')?.permission ?? 'edits';
    const next: Participant[] = roster.map((p) => {
      if (p.id === target.id) {
        const role = patch.role ?? p.role;
        return {
          ...p,
          role,
          permission: role === 'worker' ? workerPermission : 'read-only',
          model: patch.model === undefined ? p.model : patch.model || null,
        };
      }
      // Promoting somebody else to worker demotes the incumbent in the same step.
      if (patch.role === 'worker' && p.role === 'worker') {
        return { ...p, role: 'reviewer', permission: 'read-only' };
      }
      return p;
    });
    assertRoster(next, room.mode);

    for (const participant of next) {
      const before = roster.find((p) => p.id === participant.id)!;
      if (
        before.role === participant.role &&
        before.permission === participant.permission &&
        before.model === participant.model
      ) {
        continue;
      }
      this.store.updateParticipant(participant.id, {
        role: participant.role,
        permission: participant.permission,
        model: participant.model,
      });
      this.system(
        `${participant.runtime} is now ${participant.role} (${participant.permission})` +
          `${participant.model ? ` on ${participant.model}` : ''}.`,
      );
    }

    const updated = this.participants;
    this.emit({ type: 'room.roster', roomId: room.id, participants: updated });
    return updated;
  }

  /**
   * Commit whatever is in the room's working tree, on demand.
   *
   * The loop already commits an approved round; this is for the common case of a
   * `needs-you` room whose last round is real work sitting uncommitted.
   */
  async commit(message?: string): Promise<{ ok: boolean; sha?: string; error?: string }> {
    const room = this.reload();
    if (room.state === 'running' || room.state === 'waiting-reviews') {
      throw new EngineError('a turn is in flight. Pause or stop the room before committing.');
    }
    const subject = message?.trim() || commitSubject(room.title);
    const result = await git.commitAll(this.workdir(), subject, `Room: ${room.id}`);

    if (result.ok) {
      this.system(`committed ${result.shortSha} on ${room.roomBranch}: ${subject}`);
      return { ok: true, ...(result.shortSha ? { sha: result.shortSha } : {}) };
    }
    if (result.empty) {
      this.system('nothing to commit: git reported no staged changes.');
      return { ok: false, error: 'nothing to commit' };
    }
    this.system(`could not commit: ${result.error ?? 'unknown error'}`);
    return { ok: false, ...(result.error ? { error: result.error } : {}) };
  }

  /**
   * Push the room branch and open a pull request.
   *
   * This is the only thing in the project that leaves the machine, so it happens exactly
   * once per explicit request and never implicitly: the push and the resulting url both go
   * into the transcript, and a repo with no remote is refused rather than half-done.
   */
  async openPr(
    opts: { title?: string; body?: string; remote?: string; draft?: boolean; gh?: GhRunner } = {},
  ): Promise<CreatePrResult> {
    const room = this.reload();
    if (room.state === 'running' || room.state === 'waiting-reviews') {
      throw new EngineError('a turn is in flight. Pause or stop the room before opening a PR.');
    }
    if (room.roomBranch === room.baseBranch) {
      throw new EngineError(
        'this room ran in your checkout rather than on a room branch, so there is nothing to open a PR from.',
      );
    }

    const remotes = await git.remotes(room.repoRoot);
    const remote = opts.remote ?? (remotes.includes('origin') ? 'origin' : remotes[0]);
    if (!remote) {
      throw new EngineError(`${room.repoRoot} has no git remote, so there is nowhere to push.`);
    }
    const gh = await detectGh();
    if (!gh.installed) {
      throw new EngineError(gh.note ?? '`gh` is not installed');
    }

    const cwd = this.workdir();
    this.system(`pushing ${room.roomBranch} to ${remote}…`);
    const pushed = await git.push(cwd, remote, room.roomBranch);
    if (!pushed.ok) {
      this.system(`push failed: ${pushed.error ?? 'unknown error'}`);
      return { ok: false, ...(pushed.error ? { error: pushed.error } : {}) };
    }

    const title = opts.title?.trim() || commitSubject(room.title);
    const result = await createPr(
      {
        cwd,
        base: room.baseBranch,
        head: room.roomBranch,
        title,
        body: opts.body ?? prBody(room),
        ...(opts.draft ? { draft: true } : {}),
      },
      // `undefined` falls through to the real `gh`; tests always inject a fake.
      opts.gh,
    );

    if (result.ok && result.url) {
      this.roomRow = this.store.updateRoom(room.id, { prUrl: result.url });
      this.system(`opened ${result.url}`);
    } else if (result.ok) {
      this.system(`gh reported success but printed no url.`);
    } else {
      this.system(`could not open a pull request: ${result.error ?? 'unknown error'}`);
    }
    return result;
  }

  private async runRound(
    round: number,
  ): Promise<{ done: boolean; error?: string; commit?: string }> {
    const room = this.roomRow;
    this.roomRow = this.store.updateRoom(room.id, { round });
    this.setState('running');

    const worker = this.requireWorker();
    const reviewers = this.participants.filter((p) => p.role === 'reviewer');
    const cwd = this.workdir();

    // --- worker ------------------------------------------------------------
    const workerDiffStat = round > 1 ? await git.diffStat(cwd, this.baseSha()) : '';
    const workerTurn = await this.runParticipantTurn(worker, {
      round,
      cwd,
      diffStat: workerDiffStat,
    });

    if (!workerTurn.result.ok) {
      const error = workerTurn.result.error ?? 'the worker turn failed';
      this.system(`worker turn failed: ${error}`, round);
      this.setState(this.stopping ? 'stopped' : 'needs-you');
      return { done: true, error };
    }

    const diffStat = await git.diffStat(cwd, this.baseSha());
    const diff = await git.diffSince(cwd, this.baseSha());
    const changed = await git.changedFiles(cwd, this.baseSha());
    this.lastChangedFiles = changed;

    const workerMessage = this.postTurnMessage(worker, workerTurn, round, diff);
    if (changed.length === 0) {
      this.system(`round ${round}: the worker changed no files.`, round);
    }

    if (this.stopping) {
      this.setState('stopped');
      return { done: true };
    }

    // --- autonomous test runner gatekeeper ---------------------------------
    let testResults: string | undefined;
    const testCmd = this.repoConfig.config.testCommand;
    if (testCmd) {
      const startTime = Date.now();
      const timeoutMs = this.repoConfig.config.timeoutSeconds
        ? this.repoConfig.config.timeoutSeconds * 1000
        : 120_000;
      const { exitCode, output } = await this.runTestCommand(testCmd, cwd, timeoutMs);
      if (this.stopping) {
        this.setState('stopped');
        return { done: true };
      }
      const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
      testResults = `Command: ${testCmd}\nExit code: ${exitCode}\nDuration: ${durationSec}s\n\n${output}`;
      const detail = output ? `:\n\`\`\`\n${output}\n\`\`\`` : '';
      const summary = `[test runner] \`${testCmd}\` finished with exit code ${exitCode} (${durationSec}s)`;
      this.system(`${summary}${detail}`, round);
    }

    // --- reviewers, in parallel --------------------------------------------
    this.setState('waiting-reviews');
    const diffFile = this.spillDiffForReviewers(workerMessage.id, diff);

    const reviewerRequests = reviewers.map((reviewer) => ({
      reviewer,
      newMessages: this.unseenFor(reviewer),
      watermark: this.store.latestMessageId(room.id),
    }));

    const reviews = await Promise.all(
      reviewerRequests.map(async ({ reviewer, newMessages, watermark }): Promise<ReviewOutcome> => {
        const turn = await this.runParticipantTurn(reviewer, {
          round,
          cwd,
          diffStat,
          diff,
          ...(diffFile ? { diffFile } : {}),
          ...(testResults ? { testResults } : {}),
          newMessages,
          watermark,
        });
        let verdict = parseVerdict(turn.result.text, turn.result.structured);
        if (verdict.ok && round >= 3 && verdict.verdict.blocking.length > 0) {
          const enforced = enforceGoalposts(verdict.verdict, diff);
          if (enforced.downgraded.length > 0) {
            for (const d of enforced.downgraded) {
              const citStr = d.citations.map((c) => `${c.file}:${c.line}`).join(', ');
              const msg =
                `[goalpost enforcement] downgraded blocking citation from ${reviewer.runtime} ` +
                `("${d.item}") to nit: line(s) ${citStr} untouched by worker`;
              this.system(msg, round);
            }
            if (enforced.verdict.decision === 'approve' && verdict.verdict.decision !== 'approve') {
              const msg =
                `[goalpost enforcement] all blocking issues from ${reviewer.runtime} ` +
                'were on untouched code – verdict changed to APPROVE';
              this.system(msg, round);
            }
            verdict = { ...verdict, verdict: enforced.verdict };
          }
        }
        const message = this.postTurnMessage(
          reviewer,
          turn,
          round,
          null,
          verdict.ok ? verdict.verdict : null,
        );
        return { participant: reviewer, result: turn.result, message, verdict };
      }),
    );

    if (this.stopping) {
      this.setState('stopped');
      return { done: true };
    }

    return await this.tally(round, reviews, workerTurn.result.text, changed);
  }

  // --- tally ---------------------------------------------------------------

  private async tally(
    round: number,
    reviews: ReviewOutcome[],
    workerSummary: string,
    changed: string[],
  ): Promise<{ done: boolean; error?: string; commit?: string }> {
    const failed = reviews.filter((r) => !r.result.ok);
    for (const review of failed) {
      this.system(
        `${review.participant.runtime}'s review failed: ${review.result.error ?? 'unknown error'}`,
        round,
      );
    }
    if (failed.length > 0) {
      // Not something another worker round can fix: a reviewer that hit a usage limit or
      // crashed will do the same next round, and without a round budget that loop never
      // ends. Hand the room to the human, who can wait it out or change the roster.
      const error = failed[0]?.result.error ?? 'a reviewer turn failed';
      this.system(
        `a failed review cannot be addressed by the worker, so the room is waiting for you. ` +
          `Press Continue to run another round once ${failed
            .map((r) => r.participant.runtime)
            .join(' and ')} can review again, or change the roster.`,
        round,
      );
      this.setState('needs-you');
      return { done: true, error };
    }

    const ok = reviews.filter((r) => r.result.ok);
    for (const review of ok) {
      if (review.verdict.ok) continue;
      // Never guess an approval from prose. Quote the tail so the human can tell a
      // formatting slip from a refusal (the M0 rule, kept).
      const tail = review.result.text.trim().split('\n').slice(-8).join('\n');
      this.system(
        `${review.participant.runtime} did not end with a verdict block (${review.verdict.reason}). ` +
          `Counting it as not approved.${tail ? `\n\n${tail}` : ''}`,
        round,
      );
    }

    const decisions = ok.map((r) => (r.verdict.ok ? r.verdict.verdict.decision : 'no-verdict'));
    const approvals = decisions.filter((d) => d === 'approve').length;
    this.system(`round ${round}: ${approvals} of ${ok.length} approved.`, round);

    if (decisions.includes('question')) {
      // A question is by definition addressed to the human, so there is nobody else to ask.
      this.setState('needs-you');
      return { done: true };
    }

    if (ok.length > 0 && failed.length === 0 && approvals === ok.length) {
      const commit = await this.commitRound(round, workerSummary, changed);
      this.setState('approved');
      return { done: true, ...(commit ? { commit } : {}) };
    }

    // No round budget: a request-changes round is followed by another round, for as long
    // as it takes. The human has Pause and Stop for the case where it is taking too long.
    return { done: false };
  }

  /**
   * Commit the approved round on the room branch, so a room's work is never sitting only
   * in a working tree (PLAN.md section 7). A commit that fails is reported into the
   * transcript rather than thrown: the changes are still in the worktree either way.
   */
  private async commitRound(
    round: number,
    workerSummary: string,
    changed: string[],
  ): Promise<string | undefined> {
    if (changed.length === 0) {
      this.system('nothing to commit: the approved round changed no files.', round);
      return undefined;
    }
    const subject = commitSubject(this.roomRow.title);
    const body = `${workerSummary.trim()}\n\nRoom: ${this.roomRow.id}\nRound: ${round}`;
    const result = await git.commitAll(this.workdir(), subject, body);

    if (result.ok) {
      this.system(`committed ${result.shortSha} on ${this.roomRow.roomBranch}: ${subject}`, round);
      return result.shortSha;
    }
    if (result.empty) {
      this.system('nothing to commit: git reported no staged changes.', round);
      return undefined;
    }
    this.system(`could not commit the approved round: ${result.error ?? 'unknown error'}`, round);
    return undefined;
  }

  // --- turns ---------------------------------------------------------------

  private async runParticipantTurn(
    participant: Participant,
    ctx: {
      round: number;
      cwd: string;
      diffStat?: string;
      diff?: string;
      diffFile?: string;
      newMessages?: PromptMessage[];
      watermark?: string | null;
      phase?: BrainstormPhase;
      testResults?: string;
    },
  ): Promise<{ result: TurnResult; stream: TurnStream; messageId: string }> {
    const adapter = this.registry[participant.runtime];
    if (!adapter) throw new EngineError(`unknown runtime "${participant.runtime}"`);

    const room = this.roomRow;
    const role: Role = participant.role === 'owner' ? 'reviewer' : participant.role;
    const newMessages = ctx.newMessages ?? this.unseenFor(participant);
    const watermark = ctx.watermark ?? this.store.latestMessageId(room.id);
    const messageId = randomUUID();
    const turnId = randomUUID();
    const roleChanged = this.roleChangeNotice(participant, role, ctx.round, ctx.phase);

    const prompt = buildTurnPrompt({
      runtime: participant.runtime,
      role,
      title: room.title,
      round: ctx.round,
      cwd: ctx.cwd,
      branch: room.roomBranch,
      task: room.task,
      newMessages,
      ...(ctx.diffStat ? { diffStat: ctx.diffStat } : {}),
      ...(ctx.diff ? { diff: ctx.diff } : {}),
      ...(ctx.diffFile ? { diffFile: ctx.diffFile } : {}),
      ...(ctx.phase ? { phase: ctx.phase } : {}),
      ...(ctx.testResults ? { testResults: ctx.testResults } : {}),
      ...(roleChanged ? { roleChanged } : {}),
      ...(room.baseSha ? { diffCommand: `git diff ${room.baseSha}` } : {}),
    });

    // The turn row is written *before* the child is spawned. That ordering is the whole
    // restart story: a row with no `ended_at` is exactly "a turn was in flight when we died".
    const turnRecord = this.store.startTurn({
      id: turnId,
      roomId: room.id,
      participantId: participant.id,
      round: ctx.round,
      role,
      permission: participant.permission,
      logPath: turnLogPath(turnId),
    });

    this.emit({
      type: 'message.start',
      roomId: room.id,
      messageId,
      author: participant.runtime,
      role,
      round: ctx.round,
    });

    const stream = new TurnStream(room.id, turnRecord.id, messageId, (event) => this.emit(event));
    const handle = adapter.run(
      {
        cwd: ctx.cwd,
        ...(room.additionalDirs.length > 0 ? { additionalDirs: room.additionalDirs } : {}),
        prompt,
        permission: participant.permission,
        timeoutMs: this.timeoutMs,
        turnId,
        systemAppend: roleInstructions(role, {
          round: ctx.round,
          ...(ctx.phase ? { phase: ctx.phase } : {}),
        }),
        ...(role === 'reviewer' && adapter.capabilities.structuredOutput
          ? { outputSchema: verdictJsonSchema }
          : {}),
        ...(participant.sessionId ? { sessionId: participant.sessionId } : {}),
        ...(participant.model ? { model: participant.model } : {}),
      },
      stream.sink,
    );

    this.active.add(handle);
    if (this.stopping) handle.cancel(this.stopReason);
    let result: TurnResult;
    try {
      result = await handle.done;
    } finally {
      this.active.delete(handle);
    }

    const sessionId = result.sessionId ?? stream.sessionId;
    this.store.finishTurn(turnRecord.id, {
      ok: result.ok,
      exitCode: result.exitCode,
      error: result.error ?? null,
      usage: result.usage ?? null,
      sessionId: sessionId ?? null,
    });
    // Persisting the session id is what makes the next round a resume rather than a
    // cold start, and it is why a re-run round does not lose the agent's memory.
    if (sessionId && sessionId !== participant.sessionId) {
      this.store.updateParticipant(participant.id, { sessionId });
    }
    if (watermark) {
      this.store.updateParticipant(participant.id, { lastSeenMessageId: watermark });
    }
    if (!result.ok) {
      this.emit({
        type: 'message.failed',
        roomId: room.id,
        messageId,
        error: result.error ?? 'turn failed',
      });
    }

    return { result, stream, messageId };
  }

  private postTurnMessage(
    participant: Participant,
    turn: { result: TurnResult; stream: TurnStream; messageId: string },
    round: number,
    diff: string | null,
    verdict: Verdict | null = null,
  ): Message {
    const message = this.store.addMessage({
      id: turn.messageId,
      roomId: this.roomRow.id,
      participantId: participant.id,
      author: participant.runtime,
      role: participant.role,
      round,
      kind: 'agent',
      text: turn.result.text,
      activity: turn.stream.activity,
      diff,
      verdict: verdict ?? null,
    });
    this.emit({ type: 'message.done', roomId: this.roomRow.id, message });
    return message;
  }

  // --- helpers -------------------------------------------------------------

  /**
   * The "## Your role has changed" block, when this participant's last turn was taken as
   * something else.
   *
   * Claude gets its role through `--append-system-prompt` on every turn, so it would notice
   * on its own. Codex and Cursor have no system-prompt flag: `buildCodexPrompt` and
   * `buildCursorPrompt` prepend the instructions to the *first* prompt of a session and a
   * resumed turn gets nothing, so a swapped participant would otherwise carry on with the
   * rules it was given as its old self. The round is stated explicitly because the round
   * counter does not reset on a swap – a reviewer promoted at round 3 inherits the
   * no-moving-goalposts world as the worker.
   */
  private roleChangeNotice(
    participant: Participant,
    role: Role,
    round: number,
    phase?: BrainstormPhase,
  ): string | undefined {
    const previous = this.store.lastTurnFor(participant.id);
    if (!previous || previous.role === role) return undefined;
    return (
      `You were the ${previous.role.toUpperCase()} in this room until now. You are the ` +
      `${role.toUpperCase()} from this turn on, and this is round ${round}. Ignore the ` +
      `instructions you were given as the ${previous.role}; these replace them:\n\n` +
      roleInstructions(role, { round, ...(phase ? { phase } : {}) }).trim()
    );
  }

  private unseenFor(participant: Participant): PromptMessage[] {
    return this.store
      .messagesAfter(this.roomRow.id, participant.lastSeenMessageId)
      .filter((m) => m.participantId !== participant.id)
      .map((m) => ({
        author: m.author,
        ...(m.role ? { role: m.role } : {}),
        ...(m.round ? { round: m.round } : {}),
        text: m.text,
        ...(m.verdict ? { verdict: m.verdict.decision } : {}),
      }));
  }

  /**
   * A read-only reviewer has no shell, so "run `git diff`" is useless advice when the diff
   * is too big to inline. Write it somewhere and point at the file instead – reading is
   * the one thing every read-only permission level still allows.
   */
  private spillDiffForReviewers(messageId: string, diff: string): string | undefined {
    if (!diff || Buffer.byteLength(diff, 'utf8') <= DEFAULT_MAX_INLINE_DIFF_BYTES) return undefined;
    const path = diffSpillPath(messageId);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, diff);
      return path;
    } catch {
      return undefined;
    }
  }

  private requireWorker(): Participant {
    const worker = this.participants.find((p) => p.role === 'worker');
    if (!worker) throw new EngineError(`room ${this.roomRow.id} has no worker participant`);
    return worker;
  }

  /** Where turns run: the room's worktree, or the checkout when the room opted out. */
  private workdir(): string {
    return this.roomRow.worktreePath ?? this.roomRow.repoRoot;
  }

  private baseSha(): string | undefined {
    return this.roomRow.baseSha ?? undefined;
  }

  private acquireLock(): Promise<LockHandle> {
    return acquireRepoLock(this.roomRow.repoRoot, {
      ...this.lockOptions,
      onWait: (holder) => {
        this.system(
          `waiting for the write lock on ${this.roomRow.repoRoot}` +
            (holder ? ` (held by pid ${holder.pid})` : ''),
          this.roomRow.round,
        );
        this.lockOptions.onWait?.(holder);
      },
    });
  }

  private setState(state: RoomState): void {
    if (this.roomRow.state === state) return;
    assertTransition(this.roomRow.state, state);
    this.roomRow = this.store.updateRoom(this.roomRow.id, { state });
    this.emit({
      type: 'room.state',
      roomId: this.roomRow.id,
      state,
      round: this.roomRow.round,
    });
  }

  /** A system line in the transcript: round boundaries, approval counts, errors. */
  private system(text: string, round = this.roomRow.round): Message {
    const message = this.store.addMessage({
      roomId: this.roomRow.id,
      author: 'system',
      role: 'system',
      round,
      kind: 'system',
      text,
    });
    this.emit({ type: 'message.done', roomId: this.roomRow.id, message });
    return message;
  }

  private outcome(extra: { error?: string; commit?: string } = {}): RoomOutcome {
    return {
      roomId: this.roomRow.id,
      state: this.roomRow.state,
      mode: this.roomRow.mode,
      round: this.roomRow.round,
      approved: this.roomRow.state === 'approved',
      paused: this.roomRow.paused,
      changedFiles: this.lastChangedFiles,
      ...extra,
    };
  }

  private async ensureSetup(): Promise<boolean> {
    if (
      !this.roomRow.worktreePath ||
      !this.repoConfig.config.setup ||
      this.repoConfig.config.setup.length === 0
    ) {
      return true;
    }
    const alreadyDone = this.messages.some(
      (m) => m.kind === 'system' && m.round === 0 && m.text === '[setup] completed all steps',
    );
    if (alreadyDone) return true;

    const setupResult = await this.runSetup(this.repoConfig.config.setup);
    if (this.stopping) {
      this.setState('stopped');
      return false;
    }
    if (!setupResult.ok) {
      this.system(
        `[setup] failed on \`${setupResult.failedCommand}\` – stopping for human intervention`,
        0,
      );
      this.setState('needs-you');
      return false;
    }
    this.system('[setup] completed all steps', 0);
    return true;
  }

  async runSetup(
    commands: string[],
  ): Promise<{ ok: boolean; failedCommand?: string; exitCode?: number }> {
    const cwd = this.workdir();
    const timeoutMs = this.repoConfig.config.timeoutSeconds
      ? this.repoConfig.config.timeoutSeconds * 1000
      : 120_000;
    for (const cmd of commands) {
      if (this.stopping) return { ok: false };
      this.system(`[setup] running: ${cmd}`, 0);
      const { exitCode, output } = await this.runTestCommand(cmd, cwd, timeoutMs);
      const detail = output ? `:\n${output}` : '';
      if (exitCode === 0) {
        this.system(`[setup] \`${cmd}\` completed successfully${detail}`, 0);
      } else {
        this.system(`[setup] \`${cmd}\` failed with exit code ${exitCode}${detail}`, 0);
        return { ok: false, failedCommand: cmd, exitCode };
      }
    }
    return { ok: true };
  }

  private async runTestCommand(
    cmd: string,
    cwd: string,
    timeoutMs = 120_000,
  ): Promise<{ exitCode: number; output: string }> {
    if (this.stopping) {
      return { exitCode: 1, output: 'command cancelled: room stopping' };
    }
    return new Promise<{ exitCode: number; output: string }>((resolve) => {
      let settled = false;
      const child = spawn(cmd, { cwd, shell: true, detached: true, windowsHide: true });
      let combined = '';
      const MAX_OUTPUT = 64 * 1024;

      const finish = (code: number, output: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeCommandCancel = undefined;
        resolve({ exitCode: code, output: output.trim() });
      };

      const cancel = (reason = 'cancelled') => {
        killProcessTree(child, 'SIGKILL');
        finish(1, `command ${reason}`);
      };

      this.activeCommandCancel = cancel;

      const timer = setTimeout(() => {
        cancel(`timed out after ${Math.round(timeoutMs / 1000)}s`);
      }, timeoutMs);

      child.stdout?.on('data', (chunk) => {
        combined += chunk;
        if (combined.length > MAX_OUTPUT) combined = combined.slice(-MAX_OUTPUT);
      });
      child.stderr?.on('data', (chunk) => {
        combined += chunk;
        if (combined.length > MAX_OUTPUT) combined = combined.slice(-MAX_OUTPUT);
      });
      child.on('error', (err) => {
        finish(1, err.message);
      });
      child.on('close', (code) => {
        finish(code ?? 1, combined);
      });
    });
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken renderer must not take a room down.
      }
    }
  }
}

/** The first line of the task, trimmed to something that reads as a room name. */
export function deriveTitle(task: string, root: string): string {
  const firstLine = task.trim().split('\n')[0]?.trim() ?? '';
  const short = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
  return short || `task in ${basename(root)}`;
}

function commitSubject(title: string): string {
  const subject = `acr: ${title.replace(/\s+/g, ' ').trim()}`;
  return subject.length > 72 ? `${subject.slice(0, 69)}...` : subject;
}

/** The PR body: the task, plus where it came from, so a reviewer knows what they are reading. */
function prBody(room: Room): string {
  return [
    room.task.trim(),
    '',
    '---',
    '',
    `Opened by [agent-chat-room](https://github.com/elia-dot/agent-chat-room) from room \`${room.id}\``,
    `(${room.round} round${room.round === 1 ? '' : 's'}, mode ${room.mode}).`,
  ].join('\n');
}
