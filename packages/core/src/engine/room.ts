import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, mkdirSync, writeFileSync } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';

import { adapters as defaultAdapters } from '../adapters/index.js';
import type { BranchNamer } from '../branchName.js';
import { condenseSlug } from '../branchName.js';
import type { AdditionalDirInput, LoadedRepoConfig } from '../config.js';
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
import type {
  AdditionalDir,
  AdditionalDirAccess,
  Message,
  Participant,
  Room,
  RoomMode,
  RoomState,
} from '../store/types.js';
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
import type { AdditionalRepo, AdditionalRepoChange, ReadOnlySnapshot } from './additionalDirs.js';
import {
  additionalRepos,
  appendAdditionalDiffs,
  appendAdditionalStats,
  collectAdditionalRepoChanges,
  qualifiedChangedFiles,
  revertReadOnly,
  snapshotReadOnly,
  writableRepos,
} from './additionalDirs.js';
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
  /**
   * Asked for the branch slug when a room is opened without a title. Absent by default –
   * the engine then condenses the task locally – so no caller pays for a naming turn it did
   * not opt into. `agentBranchNamer` is the real implementation.
   */
  branchNamer?: BranchNamer;
  /** Retry backoff, injectable so tests do not sit through the real one. */
  retryBackoffMs?: number;
}

export interface CreateRoomInput {
  task: string;
  cwd: string;
  /** Extra absolute workspace roots granted to every runtime in the room. */
  additionalDirs?: AdditionalDirInput[];
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
  /**
   * How many times to retry a failed turn before handing the room to the human. Omitted
   * falls through to `.acr.json` and then to 0, which is the behaviour rooms always had.
   */
  maxTurnRetries?: number;
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

/**
 * Validate and canonicalise workspace roots before they reach a CLI argument list.
 *
 * Accepts the shorthand a `.acr.json` or an older client sends – a bare path string – and
 * reads it as read *and* write, which is the only thing an additional folder ever was.
 * Read-only has to be asked for.
 */
/**
 * Directories a room already owns, and what granting one back means.
 *
 * The two cases are genuinely different, which is why they are named separately rather
 * than lumped into one "the room's own paths" list.
 */
export interface RoomOwnedPaths {
  /**
   * Where the room's turns actually run – its worktree, or the checkout itself when it has
   * none. Granting this adds nothing the room does not already have, so it is dropped
   * rather than refused: a committed `.acr.json` naming a path inside the repo should not
   * hard-fail every room opened there.
   */
  workspace?: string;
  /**
   * A repository the room owns but deliberately does *not* work in: the real checkout,
   * when the room is isolated in a worktree. Granting this back is an escalation, not a
   * duplicate – it hands the agents the very tree the worktree keeps them out of – so it
   * is refused.
   */
  guarded?: string;
}

export async function validateAdditionalDirs(
  entries: readonly AdditionalDirInput[],
  owned: RoomOwnedPaths = {},
): Promise<AdditionalDir[]> {
  if (entries.length > MAX_ADDITIONAL_DIRS) {
    throw new EngineError(`a room can grant at most ${MAX_ADDITIONAL_DIRS} additional folders`);
  }

  const canonicalise = async (dir: string | undefined): Promise<string | undefined> => {
    if (!dir) return undefined;
    try {
      return await realpath(dir);
    } catch {
      return dir;
    }
  };
  const workspace = await canonicalise(owned.workspace);
  const guarded = await canonicalise(owned.guarded);
  const under = (path: string, root: string | undefined): boolean =>
    root !== undefined && (path === root || path.startsWith(`${root}/`));
  /**
   * Containment in *either* direction. Checking only downwards misses the worse half: a
   * grant for an ancestor of the room's own tree (`/Users/me` when the repo is
   * `/Users/me/proj`) contains the checkout, hands every agent write access to it, and –
   * because that parent is usually not a repository itself – is then dropped by
   * `additionalRepos`, so nothing is diffed, committed or reverted there either.
   */
  const overlaps = (path: string, root: string | undefined): boolean =>
    under(path, root) || (root !== undefined && under(root, path));

  const result: AdditionalDir[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const raw = typeof entry === 'string' ? entry : entry.path;
    const grant: AdditionalDirAccess =
      typeof entry === 'string' ? 'write' : (entry.access ?? 'write');
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
    if (overlaps(canonical, guarded)) {
      throw new EngineError(
        `"${path}" overlaps ${guarded}, the checkout this room's worktree keeps the agents ` +
          'out of. Granting it would undo that isolation, so it is refused rather than ' +
          'quietly accepted.',
      );
    }
    // Inside the room's own workspace: the room already works there, its changes are already
    // in the room's diff, and collecting them again would commit them twice. Redundant, not
    // dangerous – so it is dropped without ceremony.
    if (under(canonical, workspace)) continue;
    // Containing it is a different thing entirely: broader than the room's own tree rather
    // than a subset of it, so it cannot just be dropped as a duplicate, and accepting it
    // would put the room's own repository inside an additional folder.
    if (overlaps(canonical, workspace)) {
      throw new EngineError(
        `"${path}" contains ${workspace}, which is where this room already works. Grant the ` +
          'folders beside it rather than the one above it, or the room would collect and ' +
          'commit its own changes twice.',
      );
    }
    // A read grant is enforced by reverting the folder's repository after each turn. With
    // no repository there is nothing to revert against, and a grant the room cannot keep
    // is worse than one it refuses.
    if (grant === 'read' && !(await git.repoRoot(canonical))) {
      throw new EngineError(
        `"${path}" is not in a git repository, so read-only access cannot be enforced ` +
          'there. Grant it write access, or make it a repository first.',
      );
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      result.push({
        path: canonical,
        access: grant,
        branch: null,
        baseBranch: null,
        prUrl: null,
      });
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
 * Pause between retries of a failed turn, multiplied by the attempt number. Short on
 * purpose: the failures worth retrying are transient (a dropped connection, a brief 429),
 * and a room owner watching the transcript should not think it has wedged.
 */
const RETRY_BACKOFF_MS = 2000;

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
  private readonly retryBackoffMs: number;
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
    this.retryBackoffMs = opts.retryBackoffMs ?? RETRY_BACKOFF_MS;
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
      ...(input.maxTurnRetries === undefined ? {} : { maxTurnRetries: input.maxTurnRetries }),
    });
    // The worktree does not exist yet, and nothing the human could name can be inside a
    // directory that is about to be created – so at creation the only path worth naming is
    // the checkout, and whether it is guarded or merely redundant is exactly the question of
    // whether this room is going to be isolated from it.
    const additionalDirs = await validateAdditionalDirs(
      settings.additional_dirs ?? [],
      settings.worktree ? { guarded: repoRoot } : { workspace: repoRoot },
    );

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

    // New rooms always cut from an up-to-date base branch, independent of the branch the
    // launcher is standing on. `freshBaseSha` fetches the remote's copy without switching
    // that checkout. The base is whatever the repository calls its trunk, not always `main`.
    const base = await git.defaultBranch(repoRoot);
    const baseBranch = base.branch;
    const mainSha = await git.freshBaseSha(repoRoot, baseBranch);
    const title = input.title?.trim() || deriveTitle(task, repoRoot);
    const useWorktree = settings.worktree;
    const roomId = randomUUID();

    let roomBranch = baseBranch;
    let worktreePath: string | null = null;
    let baseSha = mainSha;

    /**
     * Every room gets a branch of its own, worktree or not.
     *
     * Without a worktree the branch is cut in the checkout you are standing in. That costs
     * a `git checkout -b` in your own repository, and it buys the thing a room is for: the
     * round's commits land somewhere that can be reviewed and opened as a pull request,
     * instead of straight onto the trunk where the only way back is a reset.
     */
    const nameRoomBranch = async (): Promise<string> => {
      const slugSource = await branchSlugSource({
        task,
        title,
        titled: Boolean(input.title?.trim()),
        repoRoot,
        adapter: registry[roster[0]!.runtime]!,
        model: roster[0]!.model,
        ...(opts.branchNamer ? { namer: opts.branchNamer } : {}),
      });
      return branchFor(await uniqueSlug(repoRoot, slugSource, roomId.replace(/-/g, '')));
    };

    if (useWorktree) {
      roomBranch = await nameRoomBranch();
      const worktree = await createWorktree({
        repoRoot,
        roomId,
        branch: roomBranch,
        startPoint: mainSha,
      });
      worktreePath = worktree.path;
      baseSha = worktree.baseSha ?? baseSha;
    } else {
      // Opting out of isolation cannot silently turn "start from the trunk" back into
      // "start from whichever branch is open". In this mode the checkout itself is the
      // workspace, so the room branch is cut *at the freshly fetched base* rather than at
      // HEAD. Standing on a feature branch is therefore fine and needs no ceremony: that
      // branch is left exactly where it is, and the room starts from the trunk regardless.
      const checkoutBranch = await git.currentBranch(repoRoot);
      if (!input.allowDirty && (await git.isDirty(repoRoot))) {
        // Without a worktree the worker edits the checkout you are standing in, so a dirty
        // tree would make the room's diff unattributable. This is the M0 behaviour, kept as
        // an escape hatch for repos where worktrees misbehave (submodules, some tooling).
        throw new EngineError(
          `${repoRoot} has uncommitted changes. Commit or stash them, drop --no-worktree, or pass --allow-dirty.`,
        );
      }
      roomBranch = await nameRoomBranch();
      try {
        await git.checkoutNewBranch(repoRoot, roomBranch, mainSha);
      } catch (err) {
        // The realistic cause is `--allow-dirty` plus changes git cannot carry from the
        // branch you are on across to the base. Say which branch it could not leave.
        throw new EngineError(
          `could not start ${roomBranch} from ${baseBranch} in ${repoRoot} while on ` +
            `${checkoutBranch}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      baseSha = (await git.headSha(repoRoot)) ?? mainSha;
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
      maxTurnRetries: settings.maxTurnRetries,
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

    // Nothing in the repository said which branch is its trunk, so the one that happened to
    // be checked out was taken as the base. That is right in a repository whose only branch
    // is the one you were on, and wrong in one whose trunk is `develop` while you stand on a
    // feature branch – and the room's whole diff is measured against this choice, so it says
    // so rather than letting the guess pass unremarked.
    if (base.source === 'checkout') {
      opts.store.addMessage({
        roomId: room.id,
        author: 'system',
        role: 'system',
        kind: 'system',
        round: 0,
        text:
          `this repository has no origin/HEAD and no local main or master, so ${baseBranch} ` +
          'is being treated as its base branch. Every diff and pull request in this room is ' +
          'measured against it.',
      });
    }

    // What each additional folder means is a decision with consequences – commits and pull
    // requests in a repository that is not this one – so the room says it out loud in the
    // transcript rather than leaving it in a settings panel nobody reopens.
    const repos = await additionalRepos(additionalDirs, [repoRoot, worktreePath ?? repoRoot]);
    if (repos.length > 0) {
      const lines = repos.map((repo) =>
        repo.dir.access === 'write'
          ? `  ${repo.root} – read & write: its changes join the room's diff, the room commits ` +
            `them there on ${branchFor(slug)}, and Open PR opens a pull request in it too.`
          : `  ${repo.root} – read only: the agents can read it, and anything they change ` +
            'there is reverted at the end of the turn.',
      );
      // Write access stages everything in that repository, because there is no worktree out
      // there keeping the room's work apart from yours.
      const dirty: string[] = [];
      for (const repo of repos) {
        if (repo.dir.access === 'write' && (await git.isDirty(repo.root))) dirty.push(repo.root);
      }
      if (dirty.length > 0) {
        lines.push(
          '',
          `Already uncommitted, and so included in the room's first commit there: ${dirty.join(', ')}. ` +
            'Commit or stash it first to keep it separate.',
        );
      }
      opts.store.addMessage({
        roomId: room.id,
        author: 'system',
        role: 'system',
        kind: 'system',
        round: 0,
        text: `folder access for this room:\n${lines.join('\n')}`,
      });
    }

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
    // Both of these used to return before the guarded loop below, so a throw inside either
    // escaped `run()` with the room still `running` – the exact state the round guard
    // exists to prevent, reachable through two of the three ways a room can be driven.
    if (opts.directTurn) {
      // Resolved before the guard, not inside it: naming somebody who is not in the room is
      // the caller's mistake and has to stay a thrown `EngineError`. Nothing has started at
      // this point, so there is nothing to abort and no room to hand back.
      const runtime = this.requireParticipant(opts.directTurn).runtime;
      try {
        return await this.runDirectTurn(runtime);
      } catch (err) {
        // A direct turn is a side conversation rather than a round: it consumes no round,
        // so nothing is rewound and no transcript is deleted. Only the room is handed back.
        return this.abortWithoutRound(err);
      }
    }
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
      } catch (err) {
        // Anything a turn did not report as a failure – a git command that blew up, a
        // store write that hit a busy database. Without this the room would stay in
        // `running` with no way back short of a restart, and any reviewer still in flight
        // would keep its CLI alive with nobody listening.
        result = this.abortRound(round, err);
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

  /**
   * A direct turn that threw. There is no round to rewind – a side conversation consumes
   * none – so this only stops what is still running and hands the room back, rather than
   * deleting a round of transcript the direct turn did not create.
   */
  private abortWithoutRound(err: unknown): RoomOutcome {
    const error = err instanceof Error ? err.message : String(err);
    for (const handle of this.active) handle.cancel(`turn aborted: ${error}`);
    this.system(`the turn was aborted: ${error}`);
    this.setState(this.stopping ? 'stopped' : 'needs-you');
    return this.outcome({ error });
  }

  /**
   * A round that threw rather than failed. Cancel whatever is still running, tell the
   * transcript, and hand the room over: the round counter rewinds so the human's Continue
   * retries it, the same as a failed worker turn.
   */
  private abortRound(round: number, err: unknown): { done: boolean; error: string } {
    const error = err instanceof Error ? err.message : String(err);
    for (const handle of this.active) handle.cancel(`round ${round} aborted: ${error}`);
    if (this.stopping) {
      this.system(`round ${round} aborted: ${error}`, round);
      this.setState('stopped');
    } else {
      // Drop the half-finished round before rewinding, exactly as `recover()` does for a
      // round that died with its process. A round aborted in `waiting-reviews` has already
      // posted the worker's message and any review that did finish; leaving those behind
      // means Continue re-runs round N and the transcript ends up holding two of each.
      //
      // The watermarks those turns advanced are left alone on purpose: `messagesAfter`
      // COALESCEs an id it can no longer find to -1, so a participant whose watermark
      // pointed into the deleted round is simply shown the transcript again.
      this.store.deleteMessagesFromRound(this.roomRow.id, round);
      this.roomRow = this.store.updateRoom(this.roomRow.id, { round: round - 1 });
      // Said after the delete, so the explanation is not swept away with the round.
      this.system(`round ${round} aborted: ${error}`, round);
      this.setState('needs-you');
    }
    return { done: true, error };
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

    // An approved room is finished as far as the engine is concerned, but naming an agent
    // is a request for one more turn, and asking for one is the whole reason the human is
    // typing. The mention reopens the room; a message with nobody named is a note, and
    // leaves it finished.
    if (this.roomRow.state === 'approved' && opts.mention) {
      this.setState('needs-you');
      this.system(`reopened by you: @${next} was asked for another turn.`, this.roomRow.round);
    }

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
    const participant = this.requireParticipant(runtime);

    // A direct turn is a side conversation, not a review cycle, so it does not consume a
    // round. Round 0 only happens before the loop has run at all.
    const round = Math.max(this.roomRow.round, 1);
    this.roomRow = this.store.updateRoom(this.roomRow.id, { round, nextSpeaker: null });
    this.setState('running');

    const cwd = this.workdir();
    const writes = canWrite(participant.permission);
    const before = await this.workspaceChanges(cwd);
    const diffStat = before.diffStat;
    // A writer is about to change the tree, so showing it the pre-turn diff is noise.
    const diff = writes ? '' : before.diff;

    const readOnlyBefore = await this.snapshotReadOnly();
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
      await this.enforceReadOnly(readOnlyBefore, round);
      const after = writes ? await this.workspaceChanges(cwd) : null;
      const captured = after ? after.diff : null;
      if (after) this.lastChangedFiles = after.changed;
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

      let result: { done: boolean; error?: string };
      try {
        result = await this.runBrainstormRound(round);
      } catch (err) {
        // Same guard the build loop has: a phase that throws aborts its round instead of
        // stranding the room in `running`.
        result = this.abortRound(round, err);
      }
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

    // `allSettled` for the same reason the reviewer fan-out uses it: one speaker's crash
    // must not abandon the others mid-turn with their CLIs still running, and with
    // `Promise.all` their rejections would go unobserved – which Node answers by killing
    // the process. The first rejection is rethrown once every turn has ended, and the
    // brainstorm loop turns that into an aborted round.
    const settled = await Promise.allSettled(
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
    const rejection = settled.find((entry) => entry.status === 'rejected');
    if (rejection && rejection.status === 'rejected') throw rejection.reason;
    const results = settled.flatMap((entry) => (entry.status === 'fulfilled' ? [entry.value] : []));

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
   *
   * `patch.runtime` replaces the runtime in place, keeping the slot and the role: this is
   * how a room swaps codex out for opencode without being reopened. That one cannot keep a
   * session – a different CLI has never heard of it – so the replacement starts cold, and
   * three things are reset with it. The session id goes, because it names a conversation
   * that only the old binary can resume. The model goes unless the same call names a new
   * one, because model ids are runtime-specific and `opencode/claude-opus-5` means nothing
   * to `claude`. And the watermark goes, so the newcomer's first prompt carries the whole
   * transcript rather than the handful of messages since a turn it never took.
   *
   * `target` is a participant row id or a runtime id. Prefer the row id: a roster may hold
   * the same runtime twice – `--agents opencode,opencode` is a legal room – and a runtime
   * id then names two participants, of which this can only resolve the first.
   */
  setParticipant(
    target: string,
    patch: { role?: Role; model?: string | null; runtime?: string },
  ): Participant[] {
    const room = this.reload();
    if (room.state === 'running' || room.state === 'waiting-reviews') {
      throw new EngineError(
        `${target} is mid-round. Pause or stop the room before changing the roster.`,
      );
    }

    const roster = this.participants;
    // Row id first: it is the only unambiguous handle when a roster holds a runtime twice.
    const slot = roster.find((p) => p.id === target) ?? roster.find((p) => p.runtime === target);
    if (!slot) {
      throw new EngineError(
        `nobody called "${target}" is in this room. Try: ${roster.map((p) => p.runtime).join(', ')}`,
      );
    }
    if (patch.role === undefined && patch.model === undefined && patch.runtime === undefined) {
      throw new EngineError('nothing to change: pass a role, a model, a runtime, or several');
    }

    const replacement = patch.runtime === slot.runtime ? undefined : patch.runtime;
    if (replacement !== undefined) {
      if (!this.registry[replacement]) {
        throw new EngineError(
          `unknown runtime "${replacement}". Run \`acr doctor\` to see what acr knows about.`,
        );
      }
      if (roster.some((p) => p.id !== slot.id && p.runtime === replacement)) {
        throw new EngineError(
          `${replacement} is already in this room. Swapping one in would leave two ` +
            'participants under the same name, which an `@mention` cannot tell apart.',
        );
      }
    }

    const workerPermission = roster.find((p) => p.role === 'worker')?.permission ?? 'edits';
    const next: Participant[] = roster.map((p) => {
      if (p.id === slot.id) {
        const role = patch.role ?? p.role;
        // A replacement drops the old model rather than inheriting it: model ids belong to
        // the runtime that offers them.
        const model =
          patch.model !== undefined
            ? patch.model || null
            : replacement !== undefined
              ? null
              : p.model;
        return {
          ...p,
          ...(replacement !== undefined ? { runtime: replacement } : {}),
          role,
          permission: role === 'worker' ? workerPermission : 'read-only',
          model,
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
      const swapped = before.runtime !== participant.runtime;
      if (
        !swapped &&
        before.role === participant.role &&
        before.permission === participant.permission &&
        before.model === participant.model
      ) {
        continue;
      }
      this.store.updateParticipant(participant.id, {
        ...(swapped
          ? { runtime: participant.runtime, sessionId: null, lastSeenMessageId: null }
          : {}),
        role: participant.role,
        permission: participant.permission,
        model: participant.model,
      });
      if (swapped) {
        this.system(
          `${before.runtime} was replaced by ${participant.runtime} as ${participant.role} ` +
            `(${participant.permission})${participant.model ? ` on ${participant.model}` : ''}. ` +
            'It starts a fresh session and is given the whole transcript on its first turn.',
        );
      } else {
        this.system(
          `${participant.runtime} is now ${participant.role} (${participant.permission})` +
            `${participant.model ? ` on ${participant.model}` : ''}.`,
        );
      }
      // An `@mention` pointing at the runtime that just left would route the next turn to
      // nobody, so it follows the slot.
      if (swapped && this.roomRow.nextSpeaker === before.runtime) {
        this.roomRow = this.store.updateRoom(room.id, { nextSpeaker: participant.runtime });
      }
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
    const body = `Room: ${room.id}`;
    const result = await git.commitAll(this.workdir(), subject, body);
    if (result.ok) {
      this.system(`committed ${result.shortSha} on ${room.roomBranch}: ${subject}`);
    } else if (!result.empty) {
      this.system(`could not commit: ${result.error ?? 'unknown error'}`);
    }

    // Always offered, even when the room repo had nothing staged: the work may be sitting
    // entirely in an additional folder.
    const extras = await this.commitAdditionalDirs(subject, body);

    if (result.ok) return { ok: true, ...(result.shortSha ? { sha: result.shortSha } : {}) };
    if (extras.length > 0) return { ok: true };
    if (result.empty) {
      this.system('nothing to commit: git reported no staged changes.');
      return { ok: false, error: 'nothing to commit' };
    }
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

    // Every repository this room committed in, room repo first. A writable additional
    // folder only appears once the room actually branched and committed there, which is
    // also the only case in which it has anything to open a pull request from.
    const targets: { cwd: string; base: string; head: string; dirPath?: string }[] = [];
    if (room.roomBranch !== room.baseBranch) {
      targets.push({ cwd: this.workdir(), base: room.baseBranch, head: room.roomBranch });
    }
    for (const repo of await this.writableExtras()) {
      const { branch, baseBranch } = repo.dir;
      if (!branch || !baseBranch || branch === baseBranch) continue;
      if ((await git.aheadCount(repo.root, baseBranch, branch)) === 0) continue;
      targets.push({ cwd: repo.root, base: baseBranch, head: branch, dirPath: repo.dir.path });
    }

    if (targets.length === 0) {
      throw new EngineError(
        room.roomBranch === room.baseBranch
          ? 'this room ran in your checkout rather than on a room branch, and it has not committed in any additional folder, so there is nothing to open a PR from.'
          : 'this room has nothing to open a PR from.',
      );
    }

    const gh = await detectGh();
    if (!gh.installed) {
      throw new EngineError(gh.note ?? '`gh` is not installed');
    }

    const title = opts.title?.trim() || commitSubject(room.title);
    const body = opts.body ?? prBody(room);
    let first: CreatePrResult | undefined;

    for (const target of targets) {
      const remotes = await git.remotes(target.cwd);
      const remote =
        opts.remote && remotes.includes(opts.remote)
          ? opts.remote
          : remotes.includes('origin')
            ? 'origin'
            : remotes[0];
      if (!remote) {
        const error = `${target.cwd} has no git remote, so there is nowhere to push.`;
        this.system(error);
        first ??= { ok: false, error };
        continue;
      }

      this.system(`pushing ${target.head} to ${remote} in ${target.cwd}…`);
      const pushed = await git.push(target.cwd, remote, target.head);
      if (!pushed.ok) {
        this.system(`push failed in ${target.cwd}: ${pushed.error ?? 'unknown error'}`);
        first ??= { ok: false, ...(pushed.error ? { error: pushed.error } : {}) };
        continue;
      }

      const result = await createPr(
        {
          cwd: target.cwd,
          base: target.base,
          head: target.head,
          title,
          body,
          ...(opts.draft ? { draft: true } : {}),
        },
        // `undefined` falls through to the real `gh`; tests always inject a fake.
        opts.gh,
      );

      if (result.ok && result.url) {
        if (target.dirPath) this.rememberExtra(target.dirPath, { prUrl: result.url });
        else this.roomRow = this.store.updateRoom(room.id, { prUrl: result.url });
        this.system(`opened ${result.url}`);
      } else if (result.ok) {
        this.system(`gh reported success but printed no url for ${target.cwd}.`);
      } else {
        this.system(
          `could not open a pull request in ${target.cwd}: ${result.error ?? 'unknown error'}`,
        );
      }
      first ??= result;
    }

    return first ?? { ok: false, error: 'nothing was pushed' };
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
    const readOnlyBefore = await this.snapshotReadOnly();
    const workerDiffStat = round > 1 ? await git.diffStat(cwd, this.baseSha()) : '';
    const workerTurn = await this.runParticipantTurn(worker, {
      round,
      cwd,
      diffStat: workerDiffStat,
    });

    if (!workerTurn.result.ok) {
      const error = workerTurn.result.error ?? 'the worker turn failed';
      this.system(`worker turn failed: ${error}`, round);
      if (this.stopping) {
        this.setState('stopped');
      } else {
        // The attempt failed, not the logical round. Keep its diagnostic in the transcript
        // but rewind the counter so Start retries this round with the same session and any
        // partial worktree edits instead of silently skipping ahead.
        this.roomRow = this.store.updateRoom(room.id, { round: round - 1 });
        this.setState('needs-you');
      }
      return { done: true, error };
    }

    // Before anything reads the tree: a read-only folder has to look untouched.
    await this.enforceReadOnly(readOnlyBefore, round);

    const { diff, diffStat, changed } = await this.workspaceChanges(cwd);
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

    // `allSettled`, so one reviewer's crash does not abandon the others mid-turn with their
    // CLIs still running. The first rejection is rethrown once every turn has ended, and
    // `runLocked` turns that into an aborted round.
    const settled = await Promise.allSettled(
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
    const reviews: ReviewOutcome[] = [];
    for (const outcome of settled) {
      if (outcome.status === 'rejected') throw outcome.reason;
      reviews.push(outcome.value);
    }

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
    } else if (!result.empty) {
      this.system(`could not commit the approved round: ${result.error ?? 'unknown error'}`, round);
    }

    const extras = await this.commitAdditionalDirs(subject, body, round);
    if (result.empty && extras.length === 0) {
      this.system('nothing to commit: git reported no staged changes.', round);
    }
    return result.ok ? result.shortSha : undefined;
  }

  // --- turns ---------------------------------------------------------------

  /**
   * One participant's turn, retried up to the room's `maxTurnRetries`.
   *
   * The retry lives here rather than in `runRound` so every caller gets it on the same
   * terms: the worker, each reviewer, a brainstorm phase and a direct turn. Each attempt
   * writes its own turn row, so `rooms show` reports what actually happened rather than
   * hiding the failures behind a success.
   *
   * A cancelled turn is never retried – the human ended it on purpose, and retrying would
   * be arguing with them. `maxTurnRetries` is 0 by default, which makes this a straight
   * pass-through and leaves the original one-failure-hands-over behaviour intact.
   */
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
    let current = participant;

    for (let attempt = 0; ; attempt += 1) {
      const turn = await this.runOneTurn(current, ctx);
      if (turn.result.ok) return turn;
      // Read fresh after every attempt, not once up front: the budget can be changed from
      // the panel while a turn is running, and a human lowering it to zero mid-failure
      // means "stop spending", which must not be answered with another paid attempt.
      const budget = Math.max(0, this.reload().maxTurnRetries);
      if (attempt >= budget) return turn;
      if (turn.result.cancelled || this.stopping) return turn;

      this.system(
        `${current.runtime}'s turn failed (attempt ${attempt + 1} of ${budget + 1}): ` +
          `${turn.result.error ?? 'unknown error'} – retrying.`,
        ctx.round,
      );
      await delay(this.retryBackoffMs * (attempt + 1));
      // The backoff is the other window a human can act in. Both a stop and a budget cut
      // during it have to be honoured before the next attempt is paid for.
      if (this.stopping) return turn;
      if (attempt >= Math.max(0, this.reload().maxTurnRetries)) return turn;
      // Re-read the row: the failed attempt may have persisted a session id, and the retry
      // should resume that session rather than start a third cold one.
      current = this.participants.find((p) => p.id === participant.id) ?? current;
    }
  }

  private async runOneTurn(
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
      ...(room.additionalDirs.length > 0 ? { additionalDirs: room.additionalDirs } : {}),
      includeRoleInstructions: !(
        adapter.capabilities.systemAppendDelivery === 'every-turn' ||
        (adapter.capabilities.systemAppendDelivery === 'first-turn' && !participant.sessionId)
      ),
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
        ...(room.additionalDirs.length > 0
          ? { additionalDirs: room.additionalDirs.map((d) => d.path) }
          : {}),
        prompt,
        permission: participant.permission,
        timeoutMs: this.timeoutMs,
        turnId,
        ...(this.repoConfig.config.userConfig === false ? { userConfig: false } : {}),
        systemAppend: roleInstructions(role, {
          round: ctx.round,
          ...(ctx.phase ? { phase: ctx.phase } : {}),
        }),
        ...(role === 'reviewer' && ctx.phase === undefined && adapter.capabilities.structuredOutput
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
    // Only on success. A turn that died before the agent ever read its prompt has not seen
    // these messages, and advancing the watermark anyway would drop them from the retry –
    // which is precisely the turn that needs them most.
    if (watermark && result.ok) {
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

  /** The participant with this runtime id, or the caller's mistake said out loud. */
  private requireParticipant(runtime: string): Participant {
    const participant = this.participants.find((p) => p.runtime === runtime);
    if (!participant) throw new EngineError(`nobody called "${runtime}" is in this room`);
    return participant;
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

  /** The repositories the room may write to, besides its own. */
  private writableExtras(): Promise<AdditionalRepo[]> {
    return writableRepos(this.roomRow.additionalDirs, [this.roomRow.repoRoot, this.workdir()]);
  }

  private readOnlyExclusions(): string[] {
    return [this.roomRow.repoRoot, this.workdir()];
  }

  /**
   * Everything the room has changed, in every repository it can write to.
   *
   * The room repo is measured against the room's base sha; an additional folder against
   * its own `HEAD`, since the room did not create it and has no base of its own there.
   * Reviewers, the goalpost check and the commit all read this, so a change made in an
   * additional folder is no longer invisible to any of them.
   */
  private async workspaceChanges(cwd: string): Promise<{
    diff: string;
    diffStat: string;
    changed: string[];
    extras: AdditionalRepoChange[];
  }> {
    const extras = await collectAdditionalRepoChanges(
      this.roomRow.additionalDirs,
      this.readOnlyExclusions(),
    );
    return {
      diff: appendAdditionalDiffs(await git.diffSince(cwd, this.baseSha()), extras),
      diffStat: appendAdditionalStats(await git.diffStat(cwd, this.baseSha()), extras),
      changed: [...(await git.changedFiles(cwd, this.baseSha())), ...qualifiedChangedFiles(extras)],
      extras,
    };
  }

  /** What the read-only folders looked like before a turn, so an edit can be told apart. */
  private snapshotReadOnly(): Promise<ReadOnlySnapshot> {
    return snapshotReadOnly(this.roomRow.additionalDirs, this.readOnlyExclusions());
  }

  /**
   * Put the read-only folders back the way the turn found them, and say so.
   *
   * No runtime can be told "you may read this folder but not write it", so a room that
   * offers read-only access has to make it true afterwards. The transcript gets the whole
   * list: silently undoing an agent's work would be worse than not offering the mode.
   */
  private async enforceReadOnly(before: ReadOnlySnapshot, round: number): Promise<void> {
    const violations = await revertReadOnly(
      this.roomRow.additionalDirs,
      before,
      this.readOnlyExclusions(),
    );
    for (const violation of violations) {
      if (violation.reverted.length > 0) {
        this.system(
          `${violation.root} is read-only in this room, so ${violation.reverted.length} ` +
            `change(s) made there were reverted: ${violation.reverted.join(', ')}. ` +
            'Grant it read & write access if the room is meant to work there.',
          round,
        );
      }
      if (violation.kept.length > 0) {
        this.system(
          `${violation.root} is read-only in this room, but these files could not be put ` +
            `back and are left as they are: ${violation.kept.join(', ')}. They were already ` +
            'modified before the turn, so there is no clean version to restore.',
          round,
        );
      }
    }
  }

  /**
   * The branch a writable additional repository commits on, created on first use.
   *
   * An additional folder is the human's own checkout rather than a worktree the room made,
   * so the only way to keep the room's commits off their branch – and to have something to
   * open a pull request from – is to cut a branch there and stay on it. That is a visible
   * change to a repository the room does not own, so it happens once, lazily, only when
   * there is something to commit, and it is announced.
   */
  private async ensureExtraBranch(repo: AdditionalRepo, round?: number): Promise<AdditionalDir> {
    if (repo.dir.branch) return repo.dir;

    const baseBranch = await git.currentBranch(repo.root);
    let name = branchFor(this.roomRow.slug);
    for (let n = 2; await git.branchExists(repo.root, name); n += 1) {
      name = `${branchFor(this.roomRow.slug)}-${n}`;
    }
    try {
      await git.checkoutNewBranch(repo.root, name);
    } catch (err) {
      this.system(
        `could not create ${name} in ${repo.root}: ${err instanceof Error ? err.message : String(err)}. ` +
          `Committing on ${baseBranch} instead.`,
        round,
      );
      return this.rememberExtra(repo.dir.path, { branch: baseBranch, baseBranch });
    }
    this.system(`created ${name} in ${repo.root}, cut from ${baseBranch}.`, round);
    return this.rememberExtra(repo.dir.path, { branch: name, baseBranch });
  }

  /** Persist per-folder state back into the room's `additional_dirs_json`. */
  private rememberExtra(path: string, patch: Partial<AdditionalDir>): AdditionalDir {
    const dirs = this.roomRow.additionalDirs.map((dir) =>
      dir.path === path ? { ...dir, ...patch } : dir,
    );
    this.roomRow = this.store.updateRoom(this.roomRow.id, { additionalDirs: dirs });
    return this.roomRow.additionalDirs.find((d) => d.path === path)!;
  }

  /**
   * Commit the writable additional folders alongside the room repo.
   *
   * Work an agent did in an `--add-dir` folder used to be left in the working tree with
   * nothing in the transcript saying so, which is how a whole round's implementation gets
   * lost.
   */
  private async commitAdditionalDirs(
    subject: string,
    body: string,
    round?: number,
  ): Promise<{ root: string; sha: string }[]> {
    const made: { root: string; sha: string }[] = [];
    for (const repo of await this.writableExtras()) {
      if (!(await git.isDirty(repo.root))) continue;
      const dir = await this.ensureExtraBranch(repo, round);
      const result = await git.commitAll(repo.root, subject, body);
      if (result.ok) {
        this.system(
          `committed ${result.shortSha} in ${repo.root} on ${dir.branch}: ${subject}`,
          round,
        );
        made.push({ root: repo.root, sha: result.shortSha ?? '' });
      } else if (!result.empty) {
        this.system(`could not commit ${repo.root}: ${result.error ?? 'unknown error'}`, round);
      }
    }
    return made;
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

/**
 * What `acr/<slug>` is built from.
 *
 * A title the human typed wins, unchanged and with no extra latency. Without one the task
 * itself is a poor branch name – it is usually a paragraph – so the room's first runtime is
 * asked for a short one, and anything short of a usable answer falls back to condensing the
 * task locally. `uniqueSlug` still owns slugification, the length cap and collisions.
 */
async function branchSlugSource(ctx: {
  task: string;
  title: string;
  /** Whether `title` came from the human rather than from the task's first line. */
  titled: boolean;
  repoRoot: string;
  adapter: AgentAdapter;
  model: string | null;
  namer?: BranchNamer;
}): Promise<string> {
  if (ctx.titled) return ctx.title;
  const named = ctx.namer
    ? await ctx.namer({
        task: ctx.task,
        title: ctx.title,
        repoRoot: ctx.repoRoot,
        adapter: ctx.adapter,
        ...(ctx.model ? { model: ctx.model } : {}),
      })
    : null;
  return named || condenseSlug(ctx.task);
}

/** The first line of the task, trimmed to something that reads as a room name. */
export function deriveTitle(task: string, root: string): string {
  const firstLine = task.trim().split('\n')[0]?.trim() ?? '';
  const short = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
  return short || `task in ${basename(root)}`;
}

/**
 * Retry backoff. Deliberately not `unref`'d, unlike the lock's own sleep: this one has to
 * actually elapse, and a room between two attempts may have nothing else keeping the loop
 * alive.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
