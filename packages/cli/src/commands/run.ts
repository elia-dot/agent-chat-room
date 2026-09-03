import type {
  Message,
  ParsedVerdict,
  RoomMode,
  RoomOutcome,
  RoomState,
} from '@agent-chat-room/core';
import {
  EngineError,
  RoomEngine,
  RoomStore,
  isTerminal,
  parseVerdict,
} from '@agent-chat-room/core';

import { EXIT, type ExitCode } from '../exit.js';
import { Renderer } from '../render.js';

export interface RunOptions {
  task?: string;
  cwd: string;
  /** Runtime ids. The first is the worker; every other one reviews. */
  agents?: string[];
  title?: string;
  /** `brainstorm` runs the three-phase discussion instead of the build loop. */
  mode?: RoomMode;
  /** Per-runtime model override, from repeated `--model <runtime>=<model>`. */
  models?: Record<string, string>;
  /** Model override for the worker turn. */
  modelWorker?: string;
  /** Model override applied to every reviewer. */
  modelReviewer?: string;
  timeoutMs?: number;
  maxRounds?: number;
  /** `false` runs in the checkout instead of a dedicated worktree. */
  worktree?: boolean;
  allowDirty?: boolean;
  /** Resume an existing room instead of opening a new one. */
  room?: string;
  renderer?: Renderer;
  /** Injectable so tests can use a disposable database. */
  store?: RoomStore;
}

export interface RunSummary {
  ok: boolean;
  exitCode: ExitCode;
  roomId: string;
  state: RoomState;
  mode: RoomMode;
  rounds: number;
  branch: string;
  base?: string;
  worktree?: string;
  changedFiles: string[];
  /** Short sha of the commit an approved room produced. */
  commit?: string;
  /** The last worker message. Kept for scripts that grew up on the M0 shape. */
  worker: { runtime: string; text: string; error?: string };
  /** The first reviewer of the final round. `reviews` has all of them. */
  reviewer?: { runtime: string; text: string; error?: string };
  verdict?: ParsedVerdict;
  reviews: { runtime: string; text: string; verdict: ParsedVerdict }[];
  error?: string;
}

/**
 * `acr run` is a renderer over `RoomEngine`.
 *
 * Everything that used to live here – the turn order, the diff capture, the verdict tally
 * – moved into the engine in M1, because the web UI in M2 has to run the same loop and a
 * loop that only exists inside a CLI command cannot be shared. What is left is argument
 * plumbing, an event subscription, and the exit-code contract.
 */
export async function run(opts: RunOptions): Promise<RunSummary> {
  const r = opts.renderer ?? new Renderer();
  const store = opts.store ?? new RoomStore();
  const ownsStore = opts.store === undefined;

  try {
    const engine = await open(opts, store);
    const room = engine.room;

    for (const warning of engine.configWarnings) r.error(`  ! ${warning}`);

    r.setMode(room.mode);
    r.info(`room "${room.title}" (${room.id.slice(0, 8)})`);
    r.info(
      `repo ${room.repoRoot} on ${room.roomBranch}${room.baseSha ? ` at ${room.baseSha.slice(0, 8)}` : ''}`,
    );
    if (room.worktreePath) r.info(`worktree ${room.worktreePath}`);
    r.info(
      engine.participants
        .map((p) => `${p.role} ${p.runtime}${p.model ? ` (${p.model})` : ''}`)
        .join(' · '),
    );
    r.info(
      room.mode === 'brainstorm'
        ? 'brainstorm: everyone answers, everyone reacts, the moderator merges'
        : `max ${room.maxRounds} rounds`,
    );

    const unsubscribe = engine.subscribe((event) => r.engineEvent(event));
    const onSignal = (): void => engine.stop('interrupted');
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    let outcome: RoomOutcome;
    try {
      outcome = await engine.run();
    } catch (err) {
      // The room lock refusing is the common case here: another acr is driving this room.
      if (err instanceof EngineError) throw new UsageError(err.message);
      throw err;
    } finally {
      unsubscribe();
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }

    return summarise(engine, outcome, r);
  } finally {
    if (ownsStore) store.close();
  }
}

async function open(opts: RunOptions, store: RoomStore): Promise<RoomEngine> {
  const engineOptions = {
    store,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  };

  if (opts.room) {
    const engine = await RoomEngine.load(opts.room, engineOptions);
    if (engine.room.state === 'approved') {
      throw new UsageError(`room ${engine.room.id.slice(0, 8)} is already approved`);
    }
    return engine;
  }

  if (!opts.task?.trim()) throw new UsageError('--task (or --task-file) is required');

  try {
    return await RoomEngine.create(
      {
        task: opts.task,
        cwd: opts.cwd,
        // Empty means "not specified": the engine falls back to `.acr.json` and then to
        // the built-in roster, which is what keeps the precedence order in one place.
        agents: opts.agents ?? [],
        ...(opts.mode ? { mode: opts.mode } : {}),
        ...(opts.models ? { models: opts.models } : {}),
        ...(opts.modelWorker ? { modelWorker: opts.modelWorker } : {}),
        ...(opts.modelReviewer ? { modelReviewer: opts.modelReviewer } : {}),
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.maxRounds ? { maxRounds: opts.maxRounds } : {}),
        ...(opts.worktree === undefined ? {} : { worktree: opts.worktree }),
        ...(opts.allowDirty ? { allowDirty: true } : {}),
      },
      engineOptions,
    );
  } catch (err) {
    // An `EngineError` is always something the human can fix from the command line.
    if (err instanceof EngineError) throw new UsageError(err.message);
    throw err;
  }
}

function summarise(engine: RoomEngine, outcome: RoomOutcome, r: Renderer): RunSummary {
  const room = engine.room;
  const messages = engine.messages;
  const finalRound = outcome.round;

  const workerMessage = last(
    messages.filter((m) => m.role === 'worker' && m.round === finalRound && m.kind === 'agent'),
  );
  const reviewMessages = messages.filter(
    (m) => m.role === 'reviewer' && m.round === finalRound && m.kind === 'agent',
  );

  const reviews = reviewMessages.map((m) => ({
    runtime: m.author,
    text: m.text,
    verdict: verdictOf(m),
  }));
  const first = reviews[0];

  const exitCode = exitCodeFor(outcome);
  r.outcome(outcome);

  return {
    ok: outcome.approved,
    exitCode,
    roomId: room.id,
    state: outcome.state,
    mode: room.mode,
    rounds: finalRound,
    branch: room.roomBranch,
    ...(room.baseSha ? { base: room.baseSha } : {}),
    ...(room.worktreePath ? { worktree: room.worktreePath } : {}),
    changedFiles: outcome.changedFiles,
    ...(outcome.commit ? { commit: outcome.commit } : {}),
    worker: {
      runtime: workerMessage?.author ?? engine.participants[0]?.runtime ?? '',
      text: workerMessage?.text ?? '',
      ...(outcome.error && !workerMessage ? { error: outcome.error } : {}),
    },
    ...(first ? { reviewer: { runtime: first.runtime, text: first.text } } : {}),
    ...(first ? { verdict: first.verdict } : {}),
    reviews,
    ...(outcome.error ? { error: outcome.error } : {}),
  };
}

/**
 * The documented exit-code contract, unchanged from M0: a script has to be able to tell
 * "the reviewers did not approve" from "acr itself broke".
 */
export function exitCodeFor(outcome: RoomOutcome): ExitCode {
  if (outcome.error) return EXIT.internalError;
  if (outcome.approved) return EXIT.ok;
  // A brainstorm has no reviewers and therefore no approval: it ends in `needs-you` with a
  // proposal, and that is success. Exit 3 would tell a script the opposite.
  if (outcome.mode === 'brainstorm') {
    return outcome.state === 'needs-you' ? EXIT.ok : EXIT.notApproved;
  }
  if (isTerminal(outcome.state)) return EXIT.notApproved;
  return EXIT.internalError;
}

function verdictOf(message: Message): ParsedVerdict {
  if (message.verdict) return { ok: true, verdict: message.verdict, raw: '' };
  return parseVerdict(message.text);
}

function last<T>(items: T[]): T | undefined {
  return items.length > 0 ? items[items.length - 1] : undefined;
}

export class UsageError extends Error {}
