import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import type { Attachment, AttachmentKind, Message, Room } from '@agent-chat-room/core';
import {
  AdditionalDirSchema,
  EngineError,
  attachmentPath,
  git,
  listModels,
  roomAttachmentsDir,
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
  /** Retries per failed turn before the room stops and asks. 0 (the default) never retries. */
  maxTurnRetries: z.number().int().min(0).max(10).optional(),
});

const ParticipantBody = z
  .object({
    role: z.enum(['worker', 'reviewer', 'moderator']).optional(),
    /** Empty string clears the override and falls back to the runtime's own default. */
    model: z.string().optional(),
    /** Replace the runtime in this slot, keeping the role. The session cannot come along. */
    runtime: z.string().min(1).optional(),
  })
  .refine((v) => v.role !== undefined || v.model !== undefined || v.runtime !== undefined, {
    message: 'nothing to change: pass a role, a model, a runtime, or several',
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

/**
 * Attachments, base64 in a JSON body.
 *
 * Multipart would be the obvious shape, but it costs a dependency (`@fastify/multipart`)
 * for one route on a loopback server that already speaks JSON everywhere else. The size
 * ceiling is what keeps that honest: a room is for a screenshot and a spec, not a video.
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Base64 is 4 bytes per 3, plus the JSON wrapper. */
const ATTACHMENT_BODY_LIMIT = Math.ceil(MAX_ATTACHMENT_BYTES * 1.4);

const UploadBody = z.object({
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(200).optional(),
  /** The file, base64-encoded, with no `data:` prefix. */
  data: z.string().min(1),
});

/** What a client hands back when it sends a message: an id it was given, never a path. */
const AttachmentRef = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(200),
  size: z.number().int().nonnegative(),
  kind: z.enum(['image', 'doc', 'room']),
});

const MessageBody = z.object({
  text: z.string().min(1, 'a message needs some text'),
  mention: z.string().min(1).optional(),
  attachments: z.array(AttachmentRef).max(20).optional(),
  /** Other rooms to put in front of the agents, by id, id prefix or slug. */
  rooms: z.array(z.string().min(1)).max(10).optional(),
});

const StartBody = z
  .object({ directTurn: z.string().min(1).optional() })
  .optional()
  .default({});

const PatchBody = z
  .object({
    title: z.string().min(1).optional(),
    additionalDirs: z.array(AdditionalDirSchema).max(20).optional(),
    maxTurnRetries: z.number().int().min(0).max(10).optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined || v.additionalDirs !== undefined || v.maxTurnRetries !== undefined,
    { message: 'nothing to change' },
  );

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
      ...(body.maxTurnRetries === undefined ? {} : { maxTurnRetries: body.maxTurnRetries }),
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
      ...(body.attachments?.length
        ? { attachments: resolveAttachments(room.id, body.attachments) }
        : {}),
      ...(body.rooms?.length ? { rooms: body.rooms } : {}),
    });
    await reply.status(201).send({ message, room: store.getRoom(room.id) });
  });

  /**
   * Take a file into the room, before the message that carries it is sent.
   *
   * Uploading first is what makes "too big" and "the disk is full" a sentence next to the
   * composer rather than a failed send. The id minted here is the only handle the client
   * gets: the path is derived from it server-side, so nothing a browser types can steer
   * the write – or a later read – out of this room's folder.
   */
  app.post(
    '/api/rooms/:id/attachments',
    { bodyLimit: ATTACHMENT_BODY_LIMIT },
    async (request, reply) => {
      const room = requireRoom(supervisor, request.params);
      const body = UploadBody.parse(request.body);

      const bytes = Buffer.from(body.data, 'base64');
      if (bytes.length === 0) throw new EngineError(`"${body.name}" is empty`);
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        const mb = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024));
        throw new EngineError(`"${body.name}" is larger than the ${mb} MB attachment limit`);
      }

      const id = randomUUID();
      const mime = normalizeMime(body.mime, body.name);
      const path = attachmentPath(room.id, id, safeExtension(body.name));
      mkdirSync(roomAttachmentsDir(room.id), { recursive: true });
      writeFileSync(path, bytes);

      const attachment: Attachment = {
        id,
        name: body.name,
        mime,
        size: bytes.length,
        kind: mime.startsWith('image/') ? 'image' : 'doc',
        path,
      };
      await reply.status(201).send({ attachment });
    },
  );

  /** The bytes back, so the transcript can show a thumbnail instead of a filename. */
  app.get('/api/rooms/:id/attachments/:attachmentId', async (request, reply) => {
    const room = requireRoom(supervisor, request.params);
    const { attachmentId } = z.object({ attachmentId: z.string().uuid() }).parse(request.params);

    const file = attachmentFile(room.id, attachmentId);
    if (!file) throw new NotFoundError(`no attachment "${attachmentId}" in this room`);
    const recorded = store
      .listMessages(room.id)
      .flatMap((m: Message) => m.attachments)
      .find((a: Attachment) => a.id === attachmentId);

    const mime = recorded?.mime ?? guessMime(file);
    await reply
      .type(mime)
      // Only the raster image types render in place. Everything else – SVG included, since
      // it carries script – downloads instead, so nothing the human dropped into a room can
      // be navigated to and executed on this app's own origin.
      .header(
        'content-disposition',
        contentDisposition(
          INLINE_IMAGE_MIMES.has(mime) ? 'inline' : 'attachment',
          recorded?.name ?? attachmentId,
        ),
      )
      .header('x-content-type-options', 'nosniff')
      .send(readFileSync(file));
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
      participants: await supervisor.setParticipant(room.id, target.id, {
        ...(body.role ? { role: body.role } : {}),
        ...(body.model === undefined ? {} : { model: body.model.trim() || null }),
        ...(body.runtime === undefined ? {} : { runtime: body.runtime }),
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
        ...(body.maxTurnRetries === undefined ? {} : { maxTurnRetries: body.maxTurnRetries }),
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

const INLINE_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
};

function guessMime(name: string): string {
  return MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** `type/subtype`, and nothing else – no parameters, no spaces, no line breaks. */
const MEDIA_TYPE_RE = /^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/;

/**
 * The mime to store and later serve.
 *
 * The browser's `File.type` is taken on trust for the ordinary types, but it is a string a
 * client chose and it ends up in a `Content-Type` header, so anything that is not plainly a
 * media type falls back to what the extension says rather than being echoed back.
 */
function normalizeMime(value: string | undefined, name: string): string {
  const mime = value?.trim().toLowerCase() ?? '';
  return MEDIA_TYPE_RE.test(mime) ? mime : guessMime(name);
}

/**
 * `Content-Disposition` for a filename that is not necessarily ASCII (RFC 6266 / RFC 5987).
 *
 * A header value is latin-1 at best, and Node refuses to send one containing anything above
 * `\xff` – so a real filename like `מסמך.pdf`, or one with an emoji in it, used to make
 * downloading the attachment fail outright with `ERR_INVALID_CHAR`. The fix is the one the
 * specs describe: a flattened ASCII `filename` every client understands, plus a
 * percent-encoded `filename*` that every current browser prefers.
 */
function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  // Quotes and backslashes would end the quoted string early; anything outside printable
  // ASCII cannot travel in a header at all.
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii || 'attachment'}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

/**
 * `encodeURIComponent`, tightened to RFC 5987's `attr-char`. It leaves `!'()*~` alone, and
 * of those only `!` and `~` are legal here.
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The extension of the uploaded name, when it is one. Everything else about the filename is
 * discarded: the name on disk is the id, so a name of `../../.ssh/authorized_keys` is just a
 * label in the transcript rather than a path.
 */
function safeExtension(name: string): string {
  const ext = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '';
}

/** The file an id names, found by its stem so the extension does not have to be guessed. */
function attachmentFile(roomId: string, attachmentId: string): string | undefined {
  const dir = roomAttachmentsDir(roomId);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  const match = entries.find(
    (entry) => entry === attachmentId || entry.startsWith(`${attachmentId}.`),
  );
  return match ? join(dir, match) : undefined;
}

/**
 * Turn the ids a client hands back into real attachments.
 *
 * The path is rebuilt from the id rather than trusted from the body, and an id with no file
 * behind it is refused rather than silently dropped – an agent told to read a file that is
 * not there is worse than a send that failed.
 */
function resolveAttachments(
  roomId: string,
  refs: { id: string; name: string; mime: string; size: number; kind: AttachmentKind }[],
): Attachment[] {
  return refs.map((ref) => {
    const path = attachmentFile(roomId, ref.id);
    if (!path) throw new NotFoundError(`the upload for "${ref.name}" is no longer on disk`);
    return { ...ref, mime: normalizeMime(ref.mime, ref.name), path };
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
