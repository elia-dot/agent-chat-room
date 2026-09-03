import { rmSync } from 'node:fs';

import type { EngineEvent } from '@agent-chat-room/core';
import { RoomStore } from '@agent-chat-room/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RoomSupervisor } from '../src/supervisor.js';
import {
  makeRepo,
  testAdapters,
  useTempConfigDir,
  verdict,
  waitFor,
  writeEchoScript,
} from './helpers.js';

const BROKEN = 'export function add(a, b) {\n  return a - b;\n}\n';
const FIXED = 'export function add(a, b) {\n  return a + b;\n}\n';

let config: ReturnType<typeof useTempConfigDir>;
let store: RoomStore;
const repos: string[] = [];

function supervisor(coalesceMs = 0): RoomSupervisor {
  return new RoomSupervisor({
    store,
    engine: { adapters: testAdapters, timeoutMs: 5000 },
    coalesceMs,
    notify: false,
  });
}

function repo(): string {
  const dir = makeRepo({ 'math.js': BROKEN });
  repos.push(dir);
  return dir;
}

beforeEach(() => {
  config = useTempConfigDir();
  process.env.ACR_NO_TURN_LOG = '1';
  store = RoomStore.open(':memory:');
});

afterEach(() => {
  store.close();
  delete process.env.ACR_ECHO_SCRIPT;
  delete process.env.ACR_NO_TURN_LOG;
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  config.restore();
});

describe('RoomSupervisor', () => {
  it('hands out one engine per room, even to callers that race', async () => {
    const s = supervisor();
    const engine = await s.create({ task: 'fix add()', cwd: repo(), agents: ['echo', 'echo2'] });

    // Two tabs subscribing in the same tick must not end up with two engines, or the loser
    // would replace a live one and orphan its running turn.
    const [a, b] = await Promise.all([s.open(engine.room.id), s.open(engine.room.id)]);
    expect(a).toBe(b);
    expect(a).toBe(engine);
    expect(await s.open(engine.room.id)).toBe(engine);
  });

  it('fans engine events out to every subscriber, and survives one that throws', async () => {
    writeEchoScript([
      { when: { role: 'worker', round: 1 }, text: 'Fixed.', writeFiles: { 'math.js': FIXED } },
      { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
    ]);
    const s = supervisor();
    const engine = await s.create({ task: 'fix add()', cwd: repo(), agents: ['echo', 'echo2'] });

    const first: EngineEvent[] = [];
    const second: EngineEvent[] = [];
    s.subscribe(() => {
      throw new Error('a broken renderer');
    });
    s.subscribe((e) => first.push(e));
    s.subscribe((e) => second.push(e));

    await s.start(engine.room.id);
    await waitFor(() => store.getRoom(engine.room.id)?.state === 'approved', 'approval');

    expect(first.length).toBeGreaterThan(0);
    expect(first.map((e) => e.type)).toEqual(second.map((e) => e.type));
    expect(first.some((e) => e.type === 'message.done')).toBe(true);
    expect(first.some((e) => e.type === 'room.state' && e.state === 'approved')).toBe(true);
  });

  it('replays the text a late subscriber missed, and forgets it when the turn lands', async () => {
    writeEchoScript([
      {
        when: { role: 'worker', round: 1 },
        events: [
          { type: 'text', text: 'thinking' },
          { type: 'text', text: ' out loud' },
          { type: 'tool', name: 'Read', summary: 'math.js' },
        ],
        delayMs: 200,
      },
      { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
    ]);
    const s = supervisor();
    const engine = await s.create({ task: 'fix add()', cwd: repo(), agents: ['echo', 'echo2'] });
    const id = engine.room.id;

    // Snapshot the buffer from inside the stream: a turn can finish between two polls, and
    // what matters is what a browser connecting *during* the turn would have been handed.
    const seen: { author: string; role: string; round: number; text: string; tools: number }[] = [];
    s.subscribe((event) => {
      if (event.type !== 'turn.activity') return;
      for (const live of s.live(id)) {
        seen.push({
          author: live.author,
          role: live.role,
          round: live.round,
          text: live.text,
          tools: live.activity.filter((a) => a.type === 'tool').length,
        });
      }
    });

    await s.start(id);
    await waitFor(() => store.getRoom(id)?.state === 'approved', 'approval');

    // This is the whole point of the buffer: a browser that connects mid-turn sees what has
    // already been said rather than an empty bubble.
    const worker = seen.filter((x) => x.role === 'worker');
    const last = worker[worker.length - 1]!;
    expect(last.author).toBe('echo');
    expect(last.round).toBe(1);
    expect(last.text).toBe('thinking out loud');
    expect(last.tools).toBe(1);

    // And it is forgotten the moment the message is persisted, so a reconnect after the
    // turn does not show the same text twice.
    expect(s.live(id)).toEqual([]);
  });

  it('coalesces deltas into one frame per tick instead of one per token', async () => {
    const chunks = Array.from({ length: 40 }, (_, i) => ({ type: 'text' as const, text: `${i} ` }));
    writeEchoScript([
      { when: { role: 'worker', round: 1 }, events: chunks },
      { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
    ]);

    const s = supervisor(50);
    const engine = await s.create({ task: 'fix add()', cwd: repo(), agents: ['echo', 'echo2'] });
    const deltas: { messageId: string; text: string }[] = [];
    s.subscribe((e) => {
      if (e.type === 'message.delta') deltas.push({ messageId: e.messageId, text: e.text });
    });

    await s.start(engine.room.id);
    await waitFor(() => store.getRoom(engine.room.id)?.state === 'approved', 'approval');

    const workerId = store
      .listMessages(engine.room.id)
      .find((m) => m.role === 'worker' && m.kind === 'agent')!.id;
    const workerDeltas = deltas.filter((d) => d.messageId === workerId);

    // Forty deltas in, far fewer frames out, and not one character lost.
    expect(workerDeltas.length).toBeGreaterThan(0);
    expect(workerDeltas.length).toBeLessThan(chunks.length);
    expect(workerDeltas.map((d) => d.text).join('')).toBe(chunks.map((c) => c.text).join(''));
  });

  it('refuses a second start, and lets the first one finish', async () => {
    writeEchoScript([
      { when: { role: 'worker', round: 1 }, text: 'Fixed.', delayMs: 100 },
      { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
    ]);
    const s = supervisor();
    const engine = await s.create({ task: 'fix add()', cwd: repo(), agents: ['echo', 'echo2'] });

    await s.start(engine.room.id);
    expect(s.isRunning(engine.room.id)).toBe(true);
    await expect(s.start(engine.room.id)).rejects.toThrow(/already running/);

    await waitFor(() => !s.isRunning(engine.room.id), 'the run to finish');
    expect(store.getRoom(engine.room.id)?.state).toBe('approved');
  });

  it('routes a start to the mention the human left behind, exactly once', async () => {
    writeEchoScript([{ when: { runtime: 'echo2', role: 'reviewer' }, text: 'Only I spoke.' }]);
    const s = supervisor();
    const engine = await s.create({ task: 'fix add()', cwd: repo(), agents: ['echo', 'echo2'] });
    const id = engine.room.id;

    await s.say(id, 'What do you think?', { mention: 'echo2' });
    expect(store.getRoom(id)!.paused).toBe(true);

    // Continuing after an @mention runs that participant, not the worker – and continuing
    // implies un-holding, or the loop would exit at the top of the first round.
    await s.start(id);
    await waitFor(() => !s.isRunning(id), 'the direct turn to finish');

    expect(store.listTurns(id)).toHaveLength(1);
    expect(
      store
        .listMessages(id)
        .filter((m) => m.kind === 'agent')
        .map((m) => m.author),
    ).toEqual(['echo2']);
    expect(store.getRoom(id)!.nextSpeaker).toBeNull();
    expect(store.getRoom(id)!.paused).toBe(false);
  });

  it('drops the engine when a room closes', async () => {
    const s = supervisor();
    const engine = await s.create({ task: 'fix add()', cwd: repo(), agents: ['echo', 'echo2'] });
    const id = engine.room.id;

    const closed = await s.close(id);
    expect(closed.closedAt).toBeTruthy();
    expect(closed.worktreePath).toBeNull();
    // A closed room has no worktree, so a later request must load a fresh engine rather
    // than reuse one pointing at a directory that is gone.
    expect(await s.open(id)).not.toBe(engine);
    await expect(s.start(id)).rejects.toThrow(/is closed/);
  });
});
