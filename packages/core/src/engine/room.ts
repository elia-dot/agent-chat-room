import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { adapters as defaultAdapters } from '../adapters/index.js';
import { loadRepoConfig, resolveRoomDefaults } from '../config.js';
import * as git from '../git.js';
import { diffPath as diffSpillPath, turnLogPath } from '../paths.js';
import { canWrite } from '../permissions.js';
import type { PromptMessage } from '../prompt.js';
import { DEFAULT_MAX_INLINE_DIFF_BYTES, buildTurnPrompt } from '../prompt.js';
import { roleInstructions } from '../roles.js';
import type { RoomStore } from '../store/rooms.js';
import type { Message, Participant, Room, RoomMode, RoomState } from '../store/types.js';
import type { AgentAdapter, Permission, TurnResult } from '../types.js';
import type { ParsedVerdict, Verdict } from '../verdict.js';
import { parseVerdict } from '../verdict.js';
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
import { acquireRepoLock } from './lock.js';
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
  /** Runtime ids. The first is the worker, every other one reviews. */
  agents: string[];
  title?: string;
  mode?: RoomMode;
  maxRounds?: number;
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
  /** Files the most recent round touched, for the outcome and the CLI's summary. */
  private lastChangedFiles: string[] = [];

  /** Non-fatal `.acr.json` complaints, surfaced by the caller rather than thrown. */
  readonly configWarnings: string[];

  private constructor(room: Room, opts: RoomEngineOptions, warnings: string[] = []) {
    this.configWarnings = warnings;
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
      ...(input.maxRounds ? { rounds: input.maxRounds } : {}),
      ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
      ...(input.models ? { models: input.models } : {}),
    });

    const workerId = settings.agents[0];
    const reviewerIds = settings.agents.slice(1);
    if (!workerId || reviewerIds.length === 0) {
      throw new EngineError(
        `a build-review room needs a worker and at least one reviewer, e.g. --agents claude,codex`,
      );
    }
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
    // The single-writer rule (PLAN.md section 3) is checked against the roster rather than
    // trusted from the flag mapping, because it is the one invariant that protects the repo.
    if (!canWrite(workerPermission)) {
      throw new EngineError(`the worker needs a writing permission, got "${workerPermission}"`);
    }
    if (canWrite(reviewerPermission)) {
      throw new EngineError(
        `reviewers must be read-only – only the worker may edit (got "${reviewerPermission}")`,
      );
    }

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
      mode: input.mode ?? 'build-review',
      repoRoot,
      baseBranch,
      roomBranch,
      baseSha,
      worktreePath,
      maxRounds: settings.rounds,
    });

    opts.store.addParticipant({
      roomId: room.id,
      runtime: workerId,
      role: 'worker',
      permission: workerPermission,
      model: input.modelWorker ?? settings.models[workerId] ?? null,
      orderIndex: 0,
    });
    reviewerIds.forEach((runtime, index) => {
      opts.store.addParticipant({
        roomId: room.id,
        runtime,
        role: 'reviewer',
        permission: reviewerPermission,
        model: input.modelReviewer ?? settings.models[runtime] ?? null,
        orderIndex: index + 1,
      });
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

    return new RoomEngine(
      room,
      { ...opts, timeoutMs: opts.timeoutMs ?? settings.timeoutSeconds * 1000 },
      repoConfig.warnings,
    );
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
      repoConfig.warnings,
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

  /** Run rounds until the room approves, needs the human, is paused, or is stopped. */
  async run(opts: RunOptions = {}): Promise<RoomOutcome> {
    if (this.roomRow.state === 'approved') return this.outcome();

    this.stopping = false;
    this.stopReason = undefined;
    if (opts.directTurn) return await this.runDirectTurn(opts.directTurn);

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
      if (round > this.roomRow.maxRounds) {
        // Resuming a room that already used up its rounds. Say so rather than looking
        // like a no-op: raising `maxRounds` is what the human has to decide.
        this.system(
          `this room has already used all ${this.roomRow.maxRounds} of its rounds. ` +
            `Raise the round limit to continue.`,
        );
        this.setState('needs-you');
        break;
      }

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
    let next = this.requireWorker().runtime;
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
      const verdict = participant.role === 'reviewer' ? parseVerdict(turn.result.text) : null;
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

    this.settle();
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
          newMessages,
          watermark,
        });
        const verdict = parseVerdict(turn.result.text);
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
    if (reviews.length > 0 && failed.length === reviews.length) {
      const error = failed[0]?.result.error ?? 'every reviewer turn failed';
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

    if (round >= this.roomRow.maxRounds) {
      const open = ok.flatMap((r) => (r.verdict.ok ? r.verdict.verdict.blocking : []));
      const list = open.length > 0 ? `\n${open.map((i) => `- ${i}`).join('\n')}` : ' none cited.';
      this.system(
        `stopping after ${round} of ${this.roomRow.maxRounds} rounds without an approval. ` +
          `Open blocking items:${list}`,
        round,
      );
      this.setState('needs-you');
      return { done: true };
    }

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
    },
  ): Promise<{ result: TurnResult; stream: TurnStream; messageId: string }> {
    const adapter = this.registry[participant.runtime];
    if (!adapter) throw new EngineError(`unknown runtime "${participant.runtime}"`);

    const room = this.roomRow;
    const role = participant.role === 'worker' ? 'worker' : 'reviewer';
    const newMessages = ctx.newMessages ?? this.unseenFor(participant);
    const watermark = ctx.watermark ?? this.store.latestMessageId(room.id);
    const messageId = randomUUID();
    const turnId = randomUUID();

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
        prompt,
        permission: participant.permission,
        timeoutMs: this.timeoutMs,
        turnId,
        systemAppend: roleInstructions(role, { round: ctx.round }),
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
      round: this.roomRow.round,
      approved: this.roomRow.state === 'approved',
      paused: this.roomRow.paused,
      changedFiles: this.lastChangedFiles,
      ...extra,
    };
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
