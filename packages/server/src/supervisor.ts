import type {
  CreateRoomInput,
  EngineEvent,
  Message,
  Participant,
  Role,
  Room,
  RoomEngineOptions,
  RoomOutcome,
  RoomStore,
  TurnEvent,
  gh,
} from '@agent-chat-room/core';
import { EngineError, RoomEngine, validateAdditionalDirs } from '@agent-chat-room/core';

import { notify, type NotifyOptions } from './notify.js';

/**
 * A turn that is streaming right now.
 *
 * HTTP is stateless but a turn is not: a browser that connects half way through a worker
 * turn has missed every delta so far, and without this it would stare at an empty bubble
 * until the turn ended. The supervisor keeps the accumulated text so a late subscriber
 * gets the same view as an early one.
 */
export interface LiveTurn {
  messageId: string;
  author: string;
  role: string;
  round: number;
  text: string;
  activity: TurnEvent[];
}

export interface SupervisorOptions {
  store: RoomStore;
  /** Passed through to every engine. Injectable so tests can supply fake adapters. */
  engine?: Omit<RoomEngineOptions, 'store'>;
  /** Milliseconds to accumulate deltas before flushing one frame. 0 disables coalescing. */
  coalesceMs?: number;
  notify?: NotifyOptions | false;
  /** Injected `gh` runner, so the PR route can be tested without a network or an account. */
  gh?: gh.GhRunner;
}

interface Entry {
  engine: RoomEngine;
  /**
   * Keyed by message id, not a single slot: reviewers run in parallel, so a room routinely
   * has two or three turns streaming at once and a single slot would drop all but one.
   */
  live: Map<string, LiveTurn>;
  /** Set while `run()` is in flight, so a second start is a 409 rather than two loops. */
  running: Promise<RoomOutcome> | undefined;
  pending: Map<string, string>;
  timer: NodeJS.Timeout | undefined;
}

const DEFAULT_COALESCE_MS = 50;

function newEntry(engine: RoomEngine): Entry {
  return {
    engine,
    live: new Map(),
    running: undefined,
    pending: new Map(),
    timer: undefined,
  };
}

/** Raised when a caller asks for something the room's current state does not allow. */
export class ConflictError extends Error {}

/**
 * One engine per room, for as long as the server lives.
 *
 * `RoomEngine.load` is cheap but not idempotent in the way HTTP needs: a running room is a
 * live object with subscribers and an in-flight child process, and every request about
 * room X has to reach *that* object rather than a fresh copy of its row. So the supervisor
 * owns the map, and every route goes through it.
 */
export class RoomSupervisor {
  private readonly rooms = new Map<string, Entry>();
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  private readonly opening = new Map<string, Promise<Entry>>();
  private readonly coalesceMs: number;

  constructor(private readonly opts: SupervisorOptions) {
    this.coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS;
  }

  get store(): RoomStore {
    return this.opts.store;
  }

  /** Subscribe to every room's events at once. Returns an unsubscribe function. */
  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The turns streaming right now, in start order. Replayed to a late subscriber. */
  live(roomId: string): LiveTurn[] {
    const entry = this.rooms.get(roomId);
    return entry ? [...entry.live.values()] : [];
  }

  isRunning(roomId: string): boolean {
    return this.rooms.get(roomId)?.running !== undefined;
  }

  /**
   * Get the engine for a room, loading it once and keeping it.
   *
   * The `opening` map is not paranoia: two browser tabs subscribing to the same room in
   * the same tick would otherwise both `await RoomEngine.load` and the loser would replace
   * a live engine with a cold one, orphaning the running turn.
   */
  async open(roomId: string): Promise<RoomEngine> {
    return (await this.entry(roomId)).engine;
  }

  private async entry(roomId: string): Promise<Entry> {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;

    const inFlight = this.opening.get(roomId);
    if (inFlight) return await inFlight;

    const promise = (async (): Promise<Entry> => {
      const engine = await RoomEngine.load(roomId, { store: this.opts.store, ...this.opts.engine });
      const entry = newEntry(engine);
      engine.subscribe((event) => this.onEngineEvent(entry, event));
      this.rooms.set(engine.room.id, entry);
      return entry;
    })();

    this.opening.set(roomId, promise);
    try {
      return await promise;
    } finally {
      this.opening.delete(roomId);
    }
  }

  /** Open a brand new room and adopt its engine, so `start` reaches the same object. */
  async create(input: CreateRoomInput): Promise<RoomEngine> {
    const engine = await RoomEngine.create(input, { store: this.opts.store, ...this.opts.engine });
    const entry = newEntry(engine);
    engine.subscribe((event) => this.onEngineEvent(entry, event));
    this.rooms.set(engine.room.id, entry);
    return engine;
  }

  /**
   * Kick the loop off in the background and return immediately: a round takes minutes and
   * the browser is watching the WebSocket, not the response body.
   */
  async start(roomId: string, opts: { directTurn?: string } = {}): Promise<Room> {
    const entry = await this.entry(roomId);
    if (entry.running) {
      throw new ConflictError(`room ${roomId.slice(0, 8)} is already running`);
    }
    if (entry.engine.room.closedAt) {
      throw new EngineError(`room ${roomId.slice(0, 8)} is closed`);
    }

    // Continuing implies un-holding: the human pressed the button, and leaving the flag on
    // would make the loop exit at the top of the very first round.
    entry.engine.resume();

    // The mention the human left behind is the default target, so "say something, then
    // continue" routes to whoever they asked rather than to the worker.
    const directTurn = opts.directTurn ?? entry.engine.room.nextSpeaker ?? undefined;
    const worker = entry.engine.participants.find((p) => p.role === 'worker');
    const direct = directTurn && directTurn !== worker?.runtime ? directTurn : undefined;

    const running = entry.engine
      .run(direct ? { directTurn: direct } : {})
      .catch((err: unknown) => {
        // The room already recorded whatever went wrong; this is the last resort for an
        // error thrown outside a turn, and it must not become an unhandled rejection.
        const message = err instanceof Error ? err.message : String(err);
        return {
          roomId,
          state: entry.engine.room.state,
          mode: entry.engine.room.mode,
          round: entry.engine.room.round,
          approved: false,
          paused: entry.engine.room.paused,
          changedFiles: [],
          error: message,
        } satisfies RoomOutcome;
      })
      .finally(() => {
        entry.running = undefined;
      });
    entry.running = running;
    return entry.engine.room;
  }

  /**
   * Edit the room row and tell the engine about it. Going through here rather than through
   * the store directly is what keeps a live engine from building its next prompt from a
   * stale row.
   */
  async patch(roomId: string, patch: { title?: string; additionalDirs?: string[] }): Promise<Room> {
    const entry = await this.entry(roomId);
    if (patch.additionalDirs !== undefined && entry.running) {
      throw new ConflictError(`room ${roomId.slice(0, 8)} is running`);
    }
    if (patch.additionalDirs !== undefined && entry.engine.room.closedAt) {
      throw new EngineError(`room ${roomId.slice(0, 8)} is closed`);
    }
    const additionalDirs =
      patch.additionalDirs === undefined
        ? undefined
        : await validateAdditionalDirs(patch.additionalDirs);
    this.opts.store.updateRoom(roomId, {
      ...patch,
      ...(additionalDirs === undefined ? {} : { additionalDirs }),
    });
    return entry.engine.reload();
  }

  /**
   * Swap a participant's role or change its model.
   *
   * Through the supervisor for the same reason `patch` is: a request about room X has to
   * reach the *live* engine, which is the object that will build the next prompt.
   */
  async setParticipant(
    roomId: string,
    runtime: string,
    patch: { role?: Role; model?: string | null },
  ): Promise<Participant[]> {
    const entry = await this.entry(roomId);
    if (entry.running) {
      throw new ConflictError(
        `room ${roomId.slice(0, 8)} is running. Pause it before changing the roster.`,
      );
    }
    return entry.engine.setParticipant(runtime, patch);
  }

  async commit(roomId: string, message?: string): Promise<{ room: Room; sha?: string }> {
    const entry = await this.entry(roomId);
    if (entry.running) throw new ConflictError(`room ${roomId.slice(0, 8)} is running`);
    const result = await entry.engine.commit(message);
    if (!result.ok) throw new EngineError(result.error ?? 'could not commit');
    return { room: entry.engine.room, ...(result.sha ? { sha: result.sha } : {}) };
  }

  async openPr(
    roomId: string,
    opts: { title?: string; body?: string; remote?: string; draft?: boolean } = {},
  ): Promise<{ room: Room; url?: string }> {
    const entry = await this.entry(roomId);
    if (entry.running) throw new ConflictError(`room ${roomId.slice(0, 8)} is running`);
    const result = await entry.engine.openPr({
      ...opts,
      ...(this.opts.gh ? { gh: this.opts.gh } : {}),
    });
    if (!result.ok) throw new EngineError(result.error ?? 'could not open a pull request');
    return { room: entry.engine.room, ...(result.url ? { url: result.url } : {}) };
  }

  /**
   * Turn a finished brainstorm into a build room: the moderator's proposal becomes the task
   * of a fresh `build-review` room on the same repo (PLAN.md section 3, "with one click").
   */
  async promote(
    roomId: string,
    opts: { agents?: string[]; title?: string } = {},
  ): Promise<RoomEngine> {
    const entry = await this.entry(roomId);
    const source = entry.engine.room;
    if (source.mode !== 'brainstorm') {
      throw new EngineError('only a brainstorm room has a proposal to promote');
    }
    const proposal = entry.engine.proposal();
    if (!proposal?.text.trim()) {
      throw new ConflictError('this brainstorm has not produced a proposal yet');
    }
    const participants = entry.engine.participants;
    // Preserve the selection order: brainstorm makes the last runtime the moderator while
    // build-review makes the first runtime the worker. Reversing this roster unexpectedly
    // promoted the moderator (often an edit-only runtime) into the build worker role.
    const agents = opts.agents ?? participants.map((p) => p.runtime);
    const models = Object.fromEntries(
      participants.flatMap((participant) =>
        participant.model ? [[participant.runtime, participant.model]] : [],
      ),
    );
    const promoted = await this.create({
      task: proposal.text.trim(),
      cwd: source.repoRoot,
      ...(source.additionalDirs.length > 0 ? { additionalDirs: source.additionalDirs } : {}),
      agents,
      ...(Object.keys(models).length > 0 ? { models } : {}),
      title: opts.title ?? `build: ${source.title}`,
    });
    await this.start(promoted.room.id);
    return promoted;
  }

  async pause(roomId: string): Promise<Room> {
    const entry = await this.entry(roomId);
    return entry.engine.pause('paused by you');
  }

  async resume(roomId: string): Promise<Room> {
    const entry = await this.entry(roomId);
    return entry.engine.resume();
  }

  async stop(roomId: string): Promise<Room> {
    const entry = await this.entry(roomId);
    entry.engine.stop('stopped by you');
    return entry.engine.room;
  }

  async say(roomId: string, text: string, opts: { mention?: string } = {}): Promise<Message> {
    const entry = await this.entry(roomId);
    const wasRunning = entry.running !== undefined;
    const completedBrainstorm =
      entry.engine.room.mode === 'brainstorm' &&
      entry.engine.room.round >= entry.engine.room.maxRounds &&
      entry.engine.proposal() !== undefined;
    const message = entry.engine.postUserMessage(text, opts);

    // A completed brainstorm has no loop left to pause and no useful default action other
    // than revising its proposal. Sending feedback is therefore the confirmation: start the
    // named participant (the moderator by default) immediately and stream the response.
    if (completedBrainstorm && !wasRunning) await this.start(roomId);
    return message;
  }

  /** Close the room: remove the worktree, keep the branch, and forget the engine. */
  async close(roomId: string): Promise<Room> {
    const entry = await this.entry(roomId);
    entry.engine.stop('room closed');
    await entry.engine.close();
    const room = entry.engine.room;
    this.forget(roomId);
    return room;
  }

  /** Stop every room and drop every engine. Called when the server shuts down. */
  async shutdown(): Promise<void> {
    const entries = [...this.rooms.values()];
    for (const entry of entries) entry.engine.stop('server shutting down');
    await Promise.allSettled(entries.map((e) => e.running ?? Promise.resolve()));
    for (const roomId of [...this.rooms.keys()]) this.forget(roomId);
  }

  private forget(roomId: string): void {
    const entry = this.rooms.get(roomId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.rooms.delete(roomId);
  }

  // --- event plumbing ------------------------------------------------------

  private onEngineEvent(entry: Entry, event: EngineEvent): void {
    switch (event.type) {
      case 'message.start':
        entry.live.set(event.messageId, {
          messageId: event.messageId,
          author: event.author,
          role: event.role,
          round: event.round,
          text: '',
          activity: [],
        });
        break;
      case 'message.delta': {
        const live = entry.live.get(event.messageId);
        if (live) live.text += event.text;
        // Claude emits a delta per block and Codex per line; one frame per delta is pure
        // waste on a socket nobody is reading character by character.
        this.queueDelta(entry, event);
        return;
      }
      case 'turn.activity':
        // `turn.activity` is keyed by turn, `message.start` by message, and nothing outside
        // the engine knows the pairing. So the buffer only claims an activity event when
        // there is exactly one turn it could belong to. When reviewers stream in parallel a
        // late subscriber gets their text now and their tool log when `message.done` lands,
        // which is the persisted list anyway.
        if (entry.live.size === 1) {
          for (const live of entry.live.values()) live.activity.push(event.event);
        }
        break;
      case 'message.done':
        this.flushDeltas(entry);
        entry.live.delete(event.message.id);
        break;
      case 'message.failed':
        this.flushDeltas(entry);
        entry.live.delete(event.messageId);
        break;
      case 'room.state':
        this.flushDeltas(entry);
        this.announce(entry, event.state);
        break;
      default:
        break;
    }
    this.publish(event);
  }

  private queueDelta(entry: Entry, event: EngineEvent & { type: 'message.delta' }): void {
    if (this.coalesceMs <= 0) {
      this.publish(event);
      return;
    }
    entry.pending.set(event.messageId, (entry.pending.get(event.messageId) ?? '') + event.text);
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      this.flushDeltas(entry);
    }, this.coalesceMs);
    // A pending flush must never hold the process open at shutdown.
    entry.timer.unref?.();
  }

  private flushDeltas(entry: Entry): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    if (entry.pending.size === 0) return;
    const batched = [...entry.pending.entries()];
    entry.pending.clear();
    for (const [messageId, text] of batched) {
      this.publish({ type: 'message.delta', roomId: entry.engine.room.id, messageId, text });
    }
  }

  private announce(entry: Entry, state: string): void {
    if (this.opts.notify === false) return;
    if (state !== 'approved' && state !== 'needs-you') return;
    const title = entry.engine.room.title;
    notify(
      state === 'approved' ? `Approved: ${title}` : `Needs you: ${title}`,
      state === 'approved'
        ? `Every reviewer approved round ${entry.engine.room.round}.`
        : 'The room is waiting on you.',
      this.opts.notify ?? {},
    );
  }

  private publish(event: EngineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One broken socket must not take a room – or the other sockets – down.
      }
    }
  }
}
