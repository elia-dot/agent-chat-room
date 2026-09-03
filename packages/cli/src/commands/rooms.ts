import type { Message, Room, RoomStore as RoomStoreType } from '@agent-chat-room/core';
import { RoomEngine, RoomStore, decisionLabel } from '@agent-chat-room/core';

import { EXIT, type ExitCode } from '../exit.js';
import { Renderer } from '../render.js';
import { UsageError, run } from './run.js';

export interface RoomsOptions {
  subcommand: string;
  id?: string;
  cwd: string;
  json?: boolean;
  renderer?: Renderer;
  store?: RoomStoreType;
  /** Passed through to `run` when resuming. */
  timeoutMs?: number;
}

/**
 * `acr rooms ls | show | resume | close` – the terminal view of the store (PLAN.md
 * section 5). M2 puts the same data behind REST; this is what makes M1's persistence
 * usable before then.
 */
export async function rooms(opts: RoomsOptions): Promise<ExitCode> {
  const r = opts.renderer ?? new Renderer();
  const store = opts.store ?? new RoomStore();
  const ownsStore = opts.store === undefined;

  try {
    switch (opts.subcommand) {
      case 'ls':
      case 'list':
        return listRooms(store, r, opts);
      case 'show':
        return showRoom(store, r, opts);
      case 'close':
        return await closeRoom(store, r, opts);
      case 'resume':
        return await resumeRoom(store, r, opts);
      default:
        throw new UsageError(
          `unknown rooms subcommand "${opts.subcommand}". Try: ls, show, resume, close.`,
        );
    }
  } finally {
    if (ownsStore) store.close();
  }
}

function listRooms(store: RoomStoreType, r: Renderer, opts: RoomsOptions): ExitCode {
  const all = store.listRooms({ limit: 50 });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
    return EXIT.ok;
  }
  if (all.length === 0) {
    r.info('no rooms yet. Start one with `acr run --task "..."`.');
    return EXIT.ok;
  }
  for (const room of all) r.roomLine(room);
  return EXIT.ok;
}

function showRoom(store: RoomStoreType, r: Renderer, opts: RoomsOptions): ExitCode {
  const room = requireRoom(store, opts.id);
  const messages = store.listMessages(room.id);
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          room,
          participants: store.listParticipants(room.id),
          messages,
          turns: store.listTurns(room.id),
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.ok;
  }

  r.roomLine(room);
  r.info(`repo ${room.repoRoot} on ${room.roomBranch}`);
  if (room.worktreePath) r.info(`worktree ${room.worktreePath}`);
  r.info(
    store
      .listParticipants(room.id)
      .map((p) => `${p.role} ${p.runtime} (${p.permission})`)
      .join(' · '),
  );

  for (const message of messages) r.transcriptMessage(message);
  return EXIT.ok;
}

async function closeRoom(store: RoomStoreType, r: Renderer, opts: RoomsOptions): Promise<ExitCode> {
  const room = requireRoom(store, opts.id);
  const engine = await RoomEngine.load(room.id, { store });
  await engine.close();
  r.info(`closed ${room.id.slice(0, 8)} – worktree removed, branch ${room.roomBranch} kept.`);
  return EXIT.ok;
}

async function resumeRoom(
  store: RoomStoreType,
  r: Renderer,
  opts: RoomsOptions,
): Promise<ExitCode> {
  const room = requireRoom(store, opts.id);
  const summary = await run({
    cwd: opts.cwd,
    room: room.id,
    renderer: r,
    store,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (opts.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.exitCode;
}

function requireRoom(store: RoomStoreType, id: string | undefined): Room {
  if (!id) throw new UsageError('this subcommand needs a room id, e.g. `acr rooms show 3f2a`');
  const room = store.findRoom(id);
  if (!room) throw new UsageError(`no room matches "${id}"`);
  return room;
}

/** Exported for the renderer, which labels reviewer messages the same way `run` does. */
export function verdictLabel(message: Message): string | undefined {
  return message.verdict ? decisionLabel(message.verdict.decision) : undefined;
}
