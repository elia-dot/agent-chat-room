import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { ServerFrame } from '../src/ws.js';
import {
  type Harness,
  harness,
  makeRepo,
  useTempConfigDir,
  verdict,
  waitFor,
  writeEchoScript,
} from './helpers.js';

const BROKEN = 'export function add(a, b) {\n  return a - b;\n}\n';
const FIXED = 'export function add(a, b) {\n  return a + b;\n}\n';

let config: ReturnType<typeof useTempConfigDir>;
let h: Harness;
let url: string;
const repos: string[] = [];
const sockets: WebSocket[] = [];

function repo(): string {
  const dir = makeRepo({ 'math.js': BROKEN });
  repos.push(dir);
  return dir;
}

/** A connected client that records every frame the server sends. */
async function connect(headers: Record<string, string> = {}): Promise<{
  socket: WebSocket;
  frames: ServerFrame[];
  closed: Promise<{ code: number; reason: string }>;
}> {
  const socket = new WebSocket(url, { headers });
  sockets.push(socket);
  const frames: ServerFrame[] = [];
  socket.on('message', (data) =>
    frames.push(JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as ServerFrame),
  );
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.on('close', (code, reason) => resolve({ code, reason: String(reason) }));
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
    socket.on('close', () => resolve());
  });
  return { socket, frames, closed };
}

async function createRoom(): Promise<string> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/rooms',
    payload: { task: 'fix add()', cwd: repo(), agents: ['echo', 'echo2'] },
  });
  return response.json<{ room: { id: string } }>().room.id;
}

beforeEach(async () => {
  config = useTempConfigDir();
  process.env.ACR_NO_TURN_LOG = '1';
  h = await harness();
  // A real listener, on a port the OS picks: the handshake and the framing are exactly
  // what `app.inject()` cannot exercise.
  const address = await h.app.listen({ host: '127.0.0.1', port: 0 });
  url = `${address.replace('http', 'ws')}/api/ws`;
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await h.close();
  delete process.env.ACR_ECHO_SCRIPT;
  delete process.env.ACR_NO_TURN_LOG;
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  config.restore();
});

describe('the room WebSocket', () => {
  it('sends a snapshot, then streams the round it is subscribed to', async () => {
    writeEchoScript([
      { when: { role: 'worker', round: 1 }, text: 'Fixed.', writeFiles: { 'math.js': FIXED } },
      { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
    ]);
    const roomId = await createRoom();
    const { socket, frames } = await connect();

    socket.send(JSON.stringify({ type: 'subscribe', roomId }));
    await waitFor(() => frames.some((f) => f.type === 'snapshot'), 'the snapshot');

    const snapshot = frames[0];
    expect(snapshot?.type).toBe('snapshot');
    if (snapshot?.type !== 'snapshot') throw new Error('unreachable');
    expect(snapshot.room.id).toBe(roomId);
    expect(snapshot.participants.map((p) => p.runtime)).toEqual(['echo', 'echo2']);
    expect(snapshot.messages.map((m) => m.kind)).toEqual(['user']);
    expect(snapshot.live).toEqual([]);
    expect(snapshot.running).toBe(false);

    await h.app.inject({ method: 'POST', url: `/api/rooms/${roomId}/start` });
    await waitFor(
      () => frames.some((f) => f.type === 'room.state' && f.state === 'approved'),
      'the room to approve',
    );

    // The engine's own event vocabulary, forwarded verbatim – no server-side translation
    // that could drift from what the terminal renderer consumes.
    const types = frames.map((f) => f.type);
    expect(types).toContain('message.start');
    expect(types).toContain('message.delta');
    expect(types).toContain('message.done');
    expect(types).toContain('turn.activity');

    const done = frames.filter((f) => f.type === 'message.done');
    expect(done.length).toBeGreaterThanOrEqual(2);
  });

  it('stops forwarding after unsubscribe, and never forwards another room', async () => {
    const watched = await createRoom();
    const other = await createRoom();
    const { socket, frames } = await connect();

    socket.send(JSON.stringify({ type: 'subscribe', roomId: watched }));
    await waitFor(() => frames.some((f) => f.type === 'snapshot'), 'the snapshot');

    await h.app.inject({
      method: 'POST',
      url: `/api/rooms/${other}/messages`,
      payload: { text: 'in the other room' },
    });
    await h.app.inject({
      method: 'POST',
      url: `/api/rooms/${watched}/messages`,
      payload: { text: 'in this one' },
    });
    await waitFor(() => frames.some((f) => f.type === 'message.done'), 'the message');

    const texts = frames.flatMap((f) => (f.type === 'message.done' ? [f.message.text] : []));
    expect(texts).toEqual(['in this one']);

    socket.send(JSON.stringify({ type: 'unsubscribe', roomId: watched }));
    socket.send(JSON.stringify({ type: 'ping' }));
    await waitFor(() => frames.some((f) => f.type === 'pong'), 'the pong');

    const before = frames.length;
    await h.app.inject({
      method: 'POST',
      url: `/api/rooms/${watched}/messages`,
      payload: { text: 'after unsubscribing' },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(frames.length).toBe(before);
  });

  it('answers a bad frame and an unknown room with an error, not a disconnect', async () => {
    const { socket, frames } = await connect();

    socket.send('not json at all');
    socket.send(JSON.stringify({ type: 'subscribe', roomId: 'nope' }));
    socket.send(JSON.stringify({ type: 'frobnicate' }));
    await waitFor(() => frames.length >= 3, 'three error frames');

    expect(frames.every((f) => f.type === 'error')).toBe(true);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('refuses a handshake from a page that is not on localhost', async () => {
    // A WebSocket handshake is not subject to CORS, so nothing in the browser stops a page
    // you have open from opening one. The upgrade never completes: it is an ordinary
    // request to `/api/ws`, and the origin hook answers it with a 403.
    const socket = new WebSocket(url, { headers: { Origin: 'https://evil.example.com' } });
    const error = await new Promise<Error>((resolve) => {
      socket.on('error', resolve);
      socket.on('open', () => resolve(new Error('the handshake succeeded')));
    });
    expect(error.message).toContain('403');
    socket.terminate();
  });

  it('accepts a handshake from the app it serves', async () => {
    const origin = url.replace('ws://', 'http://').replace('/api/ws', '');
    const { socket } = await connect({ Origin: origin });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});
