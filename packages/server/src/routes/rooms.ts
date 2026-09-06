import type { Message, Room } from '@agent-chat-room/core';
import {
  AdditionalDirSchema,
  EngineError,
  git,
  listModels,
  roomToMarkdown,
} from '@agent-chat-room/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { NotFoundError } from '../errors.js';
import type { RoomSupervisor } from '../supervisor.js';

const CreateRoomBody = z.object({
  task: z.string().min(1, 'a room needs a task'),
  cwd: z.string().min(1),
  additionalDirs: z.array(AdditionalDirSchema).max(20).optional(),
  agents: z.array(z.string().min(1)).min(2, 'a room needs a worker and at least one reviewer'),
  title: z.string().optional(),
  mode: z.enum(['build-review', 'brainstorm']).optional(),
  worktree: z.boolean().optional(),
  modelWorker: z.string().optional(),
  modelReviewer: z.string().optional(),
  /** Per-runtime model override, the shape `.acr.json` and `--model claude=opus` produce. */
  models: z.record(z.string()).optional(),
  allowDirty: z.boolean().optional(),
  /** Kick the loop off as part of creating the room, which is what the dialog does. */
  start: z.boolean().optional(),
});

const ParticipantBody = z
  .object({
    role: z.enum(['worker', 'reviewer', 'moderator']).optional(),
    /** Empty string clears the override and falls back to the runtime's own default. */
    model: z.string().optional(),
  })
  .refine((v) => v.role !== undefined || v.model !== undefined, {
    message: 'nothing to change: pass a role, a model, or both',
  });

const CommitBody = z
  .object({ message: z.string().min(1).optional() })
  .optional()
  .default({});

const PrBody = z
  .object({
    title: z.string().min(1).optional(),
    body: z.string().optional(),
    remote: z.string().min(1).optional(),
    draft: z.boolean().optional(),
  })
  .optional()
  .default({});

const PromoteBody = z
  .object({
    agents: z.array(z.string().min(1)).min(2).optional(),
    title: z.string().min(1).optional(),
  })
  .optional()
  .default({});

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
    title: z.string().min(1).optional(),
    additionalDirs: z.array(AdditionalDirSchema).max(20).optional(),
  })
  .refine((v) => v.title !== undefined || v.additionalDirs !== undefined, {
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
      ...(body.additionalDirs ? { additionalDirs: body.additionalDirs } : {}),
      agents: body.agents,
      ...(body.title ? { title: body.title } : {}),
      ...(body.mode ? { mode: body.mode } : {}),
      ...(body.models ? { models: body.models } : {}),
      ...(body.worktree === undefined ? {} : { worktree: body.worktree }),
      ...(body.modelWorker ? { modelWorker: body.modelWorker } : {}),
      ...(body.modelReviewer ? { modelReviewer: body.modelReviewer } : {}),
      ...(body.allowDirty ? { allowDirty: true } : {}),
    });

    // Asked for before the room starts, so a typo like `opus-5` is a sentence in the UI
    // rather than a dead first turn. A warning, never a rejection: the catalog is a picker
    // seed, models ship faster than it is edited, and `claude-opus-5[1m]` is legal and
    // unlistable. See `models.ts`.
    const modelWarnings = await unknownModelWarnings(body.models);

    let room = engine.room;
    if (body.start) room = await supervisor.start(room.id);

    await reply.status(201).send({
      room,
      participants: engine.participants,
      warnings: [...engine.configWarnings, ...modelWarnings],
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

  /**
   * The roster editor: role swap and model picker, which are the same operation – "change
   * a participant of a live room" – so they are one route.
   */
  app.patch('/api/rooms/:id/participants/:participantId', async (request) => {
    const room = requireRoom(supervisor, request.params);
    const { participantId } = z.object({ participantId: z.string().min(1) }).parse(request.params);
    const body = ParticipantBody.parse(request.body);

    // Addressed by runtime id, because that is what the browser, the transcript and the
    // `@mention` all use; the row id is accepted too, so a caller holding one can use it.
    const target = store
      .listParticipants(room.id)
      .find((p) => p.runtime === participantId || p.id === participantId);
    if (!target) throw new NotFoundError(`nobody called "${participantId}" is in this room`);

    return {
      participants: await supervisor.setParticipant(room.id, target.runtime, {
        ...(body.role ? { role: body.role } : {}),
        ...(body.model === undefined ? {} : { model: body.model.trim() || null }),
      }),
    };
  });

  app.post('/api/rooms/:id/commit', async (request) => {
    const room = requireRoom(supervisor, request.params);
    const body = CommitBody.parse(request.body ?? {});
    return await supervisor.commit(room.id, body.message);
  });

  app.post('/api/rooms/:id/pr', async (request) => {
    const room = requireRoom(supervisor, request.params);
    const body = PrBody.parse(request.body ?? {});
    return await supervisor.openPr(room.id, body);
  });

  app.post('/api/rooms/:id/promote', async (request, reply) => {
    const room = requireRoom(supervisor, request.params);
    const body = PromoteBody.parse(request.body ?? {});
    const engine = await supervisor.promote(room.id, body);
    await reply.status(201).send({ room: engine.room, participants: engine.participants });
  });

  app.get('/api/rooms/:id/export.md', async (request, reply) => {
    const room = requireRoom(supervisor, request.params);
    const markdown = roomToMarkdown({
      room,
      participants: store.listParticipants(room.id),
      messages: store.listMessages(room.id),
      turns: store.listTurns(room.id),
    });
    await reply
      .type('text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="${room.slug || 'room'}.md"`)
      .send(markdown);
  });

  app.patch('/api/rooms/:id', async (request) => {
    const room = requireRoom(supervisor, request.params);
    const body = PatchBody.parse(request.body);
    return {
      room: await supervisor.patch(room.id, {
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.additionalDirs === undefined ? {} : { additionalDirs: body.additionalDirs }),
      }),
    };
  });

  app.post('/api/rooms/:id/purge', async (request, reply) => {
    const room = requireRoom(supervisor, request.params);
    if (supervisor.isRunning(room.id)) {
      await reply.status(409).send({ error: `room ${room.id.slice(0, 8)} is running` });
      return;
    }
    const result = await supervisor.purge(room.id);
    return { ok: true, purged: room.id, ...result };
  });
}

/**
 * One sentence per model the runtime has never reported. Empty when the runtime offers no
 * catalog at all, because "we do not know" is not a reason to warn about a name that is
 * probably fine.
 */
async function unknownModelWarnings(models: Record<string, string> | undefined): Promise<string[]> {
  if (!models) return [];
  const warnings: string[] = [];
  for (const [runtime, model] of Object.entries(models)) {
    if (!model.trim()) continue;
    const catalog = await listModels(runtime);
    if (catalog.models.length === 0) continue;
    if (catalog.models.some((m) => m.id === model)) continue;
    warnings.push(
      `${runtime} has not reported a model called "${model}"; the turn will fail if it does not exist`,
    );
  }
  return warnings;
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
