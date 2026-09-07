import { existsSync, readdirSync, rmSync } from 'node:fs';
import { validateHeaderValue } from 'node:http';

import type { Attachment, Message, Room } from '@agent-chat-room/core';
import { roomAttachmentsDir } from '@agent-chat-room/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type Harness, harness, makeRepo, useTempConfigDir } from './helpers.js';

const BROKEN = 'export function add(a, b) {\n  return a - b;\n}\n';

/** A one-pixel PNG, so the route has something with a real image mime to serve back. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let config: ReturnType<typeof useTempConfigDir>;
let h: Harness;
const repos: string[] = [];

function repo(): string {
  const dir = makeRepo({ 'math.js': BROKEN });
  repos.push(dir);
  return dir;
}

async function createRoom(over: Record<string, unknown> = {}): Promise<Room> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/rooms',
    payload: { task: 'fix add()', cwd: repo(), agents: ['echo', 'echo2'], ...over },
  });
  return response.json<{ room: Room }>().room;
}

async function upload(
  roomId: string,
  name: string,
  mime: string,
  data: string,
): Promise<Attachment> {
  const response = await h.app.inject({
    method: 'POST',
    url: `/api/rooms/${roomId}/attachments`,
    payload: { name, mime, data },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ attachment: Attachment }>().attachment;
}

/**
 * Send the upload into the room, which is what puts its name and mime on record.
 *
 * The GET route reads that metadata from the message, so a test that only uploads is asking
 * about an attachment nothing has claimed yet – and would be told the filename is a uuid.
 * Nothing in the app fetches one before it is sent: the composer previews from a blob URL.
 */
async function send(roomId: string, attachment: Attachment): Promise<void> {
  const { id, name, mime, size, kind } = attachment;
  const response = await h.app.inject({
    method: 'POST',
    url: `/api/rooms/${roomId}/messages`,
    payload: { text: 'here it is', attachments: [{ id, name, mime, size, kind }] },
  });
  expect(response.statusCode).toBe(201);
}

beforeEach(async () => {
  config = useTempConfigDir();
  process.env.ACR_NO_TURN_LOG = '1';
  h = await harness();
});

afterEach(async () => {
  await h.close();
  delete process.env.ACR_NO_TURN_LOG;
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  config.restore();
});

describe('attachment routes', () => {
  it('takes a file, keeps it under the room, and hands it back', async () => {
    const room = await createRoom();
    const attachment = await upload(room.id, 'shot.png', 'image/png', PNG_BASE64);

    expect(attachment.kind).toBe('image');
    expect(attachment.path.startsWith(roomAttachmentsDir(room.id))).toBe(true);
    expect(existsSync(attachment.path)).toBe(true);
    await send(room.id, attachment);

    const fetched = await h.app.inject({
      url: `/api/rooms/${room.id}/attachments/${attachment.id}`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers['content-type']).toContain('image/png');
    expect(fetched.headers['content-disposition']).toContain('inline; filename="shot.png"');
    expect(fetched.rawPayload.equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true);
  });

  it('never lets the uploaded name decide where the file lands', async () => {
    const room = await createRoom();
    const attachment = await upload(
      room.id,
      '../../../../etc/authorized_keys',
      'text/plain',
      Buffer.from('nope').toString('base64'),
    );

    expect(attachment.path.startsWith(`${roomAttachmentsDir(room.id)}/`)).toBe(true);
    // The name survives as a label only, and the file on disk is named for its id.
    expect(attachment.name).toBe('../../../../etc/authorized_keys');
    expect(readdirSync(roomAttachmentsDir(room.id))).toEqual([attachment.id]);
  });

  it('serves a filename no header can carry, rather than failing the download', async () => {
    const room = await createRoom();
    // Hebrew and an emoji: both are above `\xff`, which Node refuses to put in a header at
    // all. This used to come back as ERR_INVALID_CHAR instead of the file.
    const attachment = await upload(room.id, 'מסמך 📎.pdf', 'application/pdf', 'aGVsbG8=');
    await send(room.id, attachment);

    const fetched = await h.app.inject({
      url: `/api/rooms/${room.id}/attachments/${attachment.id}`,
    });
    expect(fetched.statusCode).toBe(200);

    const disposition = fetched.headers['content-disposition'] as string;
    // The ASCII half is a fallback every client can read; the real name rides in `filename*`.
    expect(disposition).toContain('attachment; filename="____ __.pdf"');
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('מסמך 📎.pdf')}`);
    // The header has to be something Node would actually put on the wire.
    expect(() => validateHeaderValue('content-disposition', disposition)).not.toThrow();
  });

  it('does not let a quote in a filename break out of the header', async () => {
    const room = await createRoom();
    const attachment = await upload(room.id, 'a"; x="y.txt', 'text/plain', 'aGVsbG8=');
    await send(room.id, attachment);

    const fetched = await h.app.inject({
      url: `/api/rooms/${room.id}/attachments/${attachment.id}`,
    });
    expect(fetched.headers['content-disposition']).toContain('filename="a_; x=_y.txt"');
  });

  it('falls back to the extension when the client"s mime is not one', async () => {
    const room = await createRoom();
    // A `Content-Type` is a header, so a client-chosen string with a line break in it never
    // gets echoed back – the extension decides instead.
    const attachment = await upload(room.id, 'shot.png', 'image/png\r\nX-Evil: 1', PNG_BASE64);
    expect(attachment.mime).toBe('image/png');
    await send(room.id, attachment);

    const fetched = await h.app.inject({
      url: `/api/rooms/${room.id}/attachments/${attachment.id}`,
    });
    expect(fetched.headers['x-evil']).toBeUndefined();
    expect(fetched.headers['content-type']).toContain('image/png');
  });

  it('serves anything that is not a raster image as a download', async () => {
    const room = await createRoom();
    const attachment = await upload(
      room.id,
      'evil.svg',
      'image/svg+xml',
      Buffer.from('<svg onload="alert(1)"/>').toString('base64'),
    );
    await send(room.id, attachment);

    const fetched = await h.app.inject({
      url: `/api/rooms/${room.id}/attachments/${attachment.id}`,
    });
    expect(fetched.headers['content-type']).toContain('image/svg+xml');
    expect(fetched.headers['content-disposition']).toContain('attachment; filename="evil.svg"');
    expect(fetched.headers['x-content-type-options']).toBe('nosniff');
  });

  it('carries the attachment into the message, rebuilding the path from the id', async () => {
    const room = await createRoom();
    const attachment = await upload(room.id, 'spec.md', 'text/markdown', 'aGVsbG8=');

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/messages`,
      payload: {
        text: 'here is the spec',
        // A path in the body is ignored: the server has its own. So is a mime that is not
        // one – the message route normalizes it, not just the upload route.
        attachments: [
          {
            id: attachment.id,
            name: attachment.name,
            mime: 'text/markdown\r\nX-Evil: 1',
            size: attachment.size,
            kind: 'doc',
            path: '/etc/passwd',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    const { message } = response.json<{ message: Message }>();
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]!.path).toBe(attachment.path);
    expect(message.attachments[0]!.mime).toBe('text/markdown');
  });

  it('refuses an id with no file behind it', async () => {
    const room = await createRoom();
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/messages`,
      payload: {
        text: 'here is the spec',
        attachments: [
          {
            id: '11111111-2222-3333-4444-555555555555',
            name: 'gone.md',
            mime: 'text/markdown',
            size: 4,
            kind: 'doc',
          },
        ],
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('attaches another room"s transcript when the message references it', async () => {
    const source = await createRoom({ title: 'The auth spike' });
    const target = await createRoom();

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/rooms/${target.id}/messages`,
      payload: { text: 'follow what we decided there', rooms: [source.slug] },
    });

    expect(response.statusCode).toBe(201);
    const { message } = response.json<{ message: Message }>();
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]!.kind).toBe('room');
    expect(message.attachments[0]!.roomRef?.id).toBe(source.id);
    expect(existsSync(message.attachments[0]!.path)).toBe(true);
  });
});
