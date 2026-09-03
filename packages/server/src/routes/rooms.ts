import type { Message, Room } from '@agent-chat-room/core';
import { EngineError, git } from '@agent-chat-room/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { NotFoundError } from '../errors.js';
import type { RoomSupervisor } from '../supervisor.js';

const CreateRoomBody = z.object({
  task: z.string().min(1, 'a room needs a task'),
  cwd: z.string().min(1),
  agents: z.array(z.string().min(1)).min(2, 'a room needs a worker and at least one reviewer'),
  title: z.string().optional(),
  maxRounds: z.number().int().positive().max(50).optional(),
  worktree: z.boolean().optional(),
  modelWorker: z.string().optional(),
  modelReviewer: z.string().optional(),
  allowDirty: z.boolean().optional(),
  /** Kick the loop off as part of creating the room, which is what the dialog does. */
  start: z.boolean().optional(),
});

const MessageBody = z.object({
  text: z.string().min(1, 'a message needs some text'),
  mention: z.string().min(1).optional(),
});

const StartBody = z
  .object({ directTurn: z.string().min(1).optional() })
  .optional()
  .default({});

const PatchBody = z
  .object({
    maxRounds: z.number().int().positive().max(50).optional(),
    title: z.string().min(1).optional(),
  })
  .refine((v) => v.maxRounds !== undefined || v.title !== undefined, {
    message: 'nothing to change',
  });

const ListQuery = z.object({
  repo: z.string().optional(),
  open: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const MessagesQuery = z.object({
  afterSeq: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

/**
 * The room REST surface. Every handler is a thin translation of a supervisor call: the
 * rules about who may run and when live in the engine, so a second client (the CLI, a
 * script) cannot get a different answer by taking a different door.
 */
export function roomRoutes(app: FastifyInstance, supervisor: RoomSupervisor): void {
  const store = supervisor.store;

  app.get('/api/rooms', (request) => {
    const query = ListQuery.parse(request.query);
    return store.listRooms({
      ...(query.repo ? { repoRoot: query.repo } : {}),
      ...(query.open ? { open: true } : {}),
      limit: query.limit ?? 100,
    });
  });

  app.post('/api/rooms', async (request, reply) => {
    const body = CreateRoomBody.parse(request.body);
    const engine = await supervisor.create({
      task: body.task,
      cwd: body.cwd,
      agents: body.agents,
      ...(body.title ? { title: body.title } : {}),
      ...(body.maxRounds ? { maxRounds: body.maxRounds } : {}),
      ...(body.worktree === undefined ? {} : { worktree: body.worktree }),
      ...(body.modelWorker ? { modelWorker: body.modelWorker } : {}),
      ...(body.modelReviewer ? { modelReviewer: body.modelReviewer } : {}),
      ...(body.allowDirty ? { allowDirty: true } : {}),
    });

    let room = engine.room;
    if (body.start) room = await supervisor.start(room.id);

    await reply.status(201).send({
      room,
      participants: engine.participants,
      warnings: engine.configWarnings,
    });
  });

  app.get('/api/rooms/:id', (request) => {
    const room = requireRoom(supervisor, request.params);
    return {
      room,
      participants: store.listParticipants(room.id),
      messages: store.listMessages(room.id),
      turns: store.listTurns(room.id),
      live: supervisor.live(room.id),
      running: supervisor.isRunning(room.id),
    };
  });

  app.get('/api/rooms/:id/messages', (request) => {
    const room = requireRoom(supervisor, request.params);
    const query = MessagesQuery.parse(request.query);
    // The tail, not the history: `better-sqlite3` is synchronous, so a room with a thousand
    // messages would otherwise block every other request while it serialised them.
    const all = store.listMessages(room.id);
    const after = query.afterSeq ?? -1;
    const filtered = all.filter((m: Message) => m.seq > after);
    return query.limit ? filtered.slice(-query.limit) : filtered;
  });

  app.get('/api/rooms/:id/diff', async (request, reply) => {
    const room = requireRoom(supervisor, request.params);
    const { message: messageId } = z.object({ message: z.string().min(1) }).parse(request.query);

    const message = store.getMessage(messageId);
    if (!message || message.roomId !== room.id) {
      throw new NotFoundError(`no message "${messageId}" in this room`);
    }
    // `readDiff` is what handles the spilled-to-disk case, which is exactly the case a
    // browser is most likely to ask about.
    await reply.type('text/plain; charset=utf-8').send(store.readDiff(message) ?? '');
  });

  app.get('/api/rooms/:id/files', async (request) => {
    const room = requireRoom(supervisor, request.params);
    const cwd = room.worktreePath ?? room.repoRoot;
    const base = room.baseSha ?? undefined;
    const [changed, stat] = await Promise.all([
      git.changedFiles(cwd, base),
      git.diffStat(cwd, base),
    ]);
    return { changed, stat };
  });

  app.post('/api/rooms/:id/messages', async (request, reply) => {
    const room = requireRoom(supervisor, request.params);
    const body = MessageBody.parse(request.body);
    const message = await supervisor.say(room.id, body.text, {
      ...(body.mention ? { mention: body.mention } : {}),
    });
    await reply.status(201).send({ message, room: store.getRoom(room.id) });
  });

  app.post('/api/rooms/:id/start', async (request) => {
    const room = requireRoom(supervisor, request.params);
    const body = StartBody.parse(request.body ?? {});
    return { room: await supervisor.start(room.id, body) };
  });

  app.post('/api/rooms/:id/pause', async (request) => {
    const room = requireRoom(supervisor, request.params);
    return { room: await supervisor.pause(room.id) };
  });

  app.post('/api/rooms/:id/resume', async (request) => {
    const room = requireRoom(supervisor, request.params);
    return { room: await supervisor.resume(room.id) };
  });

  app.post('/api/rooms/:id/stop', async (request) => {
    const room = requireRoom(supervisor, request.params);
    return { room: await supervisor.stop(room.id) };
  });

  app.post('/api/rooms/:id/close', async (request) => {
    const room = requireRoom(supervisor, request.params);
    return { room: await supervisor.close(room.id) };
  });

  app.patch('/api/rooms/:id', (request) => {
    const room = requireRoom(supervisor, request.params);
    const body = PatchBody.parse(request.body);
    // Raising the round limit is the one edit M2 needs: without it a room that used up its
    // rounds dead-ends in the browser, and the engine's own message says to raise it.
    return {
      room: supervisor.patch(room.id, {
        ...(body.maxRounds === undefined ? {} : { maxRounds: body.maxRounds }),
        ...(body.title === undefined ? {} : { title: body.title }),
      }),
    };
  });
}

function requireRoom(supervisor: RoomSupervisor, params: unknown): Room {
  const { id } = z.object({ id: z.string().min(1) }).parse(params);
  let room: Room | undefined;
  try {
    room = supervisor.store.findRoom(id);
  } catch (err) {
    // An ambiguous id prefix is the human's problem to fix, not a server fault.
    throw new EngineError(err instanceof Error ? err.message : String(err));
  }
  if (!room) throw new NotFoundError(`no room matches "${id}"`);
  return room;
}
