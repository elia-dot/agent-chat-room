import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { echoAdapter, resetEchoAdapter } from '../../src/adapters/echo.js';
import type { EngineEvent } from '../../src/engine/events.js';
import { RoomEngine } from '../../src/engine/room.js';
import { attachmentPath, roomAttachmentsDir } from '../../src/paths.js';
import { RoomStore } from '../../src/store/rooms.js';
import type { AgentAdapter, TurnRequest } from '../../src/types.js';
import { makeRepo, useTempConfigDir, writeEchoScript } from '../helpers.js';

const BROKEN = 'export function add(a, b) {\n  return a - b;\n}\n';
const FIXED = 'export function add(a, b) {\n  return a + b;\n}\n';

const verdict = (decision: string): string =>
  `Review body.\n\n\`\`\`verdict\n${JSON.stringify({ decision, blocking: [], nits: [] })}\n\`\`\``;

let config: ReturnType<typeof useTempConfigDir>;
let store: RoomStore;
const repos: string[] = [];
const requests: TurnRequest[] = [];

const spyEcho: AgentAdapter = {
  ...echoAdapter,
  run(req, sink) {
    requests.push(req);
    return echoAdapter.run(req, sink);
  },
};

const spyEcho2: AgentAdapter = {
  ...spyEcho,
  id: 'echo2',
  run: (req, sink) => spyEcho.run(req, sink),
};

function repo(): string {
  const dir = makeRepo({ 'math.js': BROKEN });
  repos.push(dir);
  return dir;
}

function script(turns: unknown[]): void {
  process.env.ACR_ECHO_SCRIPT = writeEchoScript({ turns });
}

function open(dir: string, task = 'Fix math.js.'): Promise<RoomEngine> {
  return RoomEngine.create(
    { task, cwd: dir, agents: ['echo', 'echo2'] },
    { store, adapters: { echo: spyEcho, echo2: spyEcho2 }, timeoutMs: 5000 },
  );
}

const workerPrompt = (): string => requests.find((r) => r.prompt.includes('as WORKER'))!.prompt;

beforeEach(() => {
  config = useTempConfigDir();
  process.env.ACR_NO_TURN_LOG = '1';
  store = RoomStore.open();
  requests.length = 0;
  resetEchoAdapter();
});

afterEach(() => {
  store.close();
  delete process.env.ACR_ECHO_SCRIPT;
  delete process.env.ACR_NO_TURN_LOG;
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetEchoAdapter();
  config.restore();
});

describe('attachments', () => {
  it('names an attached file in the next turn"s prompt and grants the folder', async () => {
    const dir = repo();
    script([{ when: { role: 'worker', round: 1 }, text: 'Looked at it.' }]);
    const engine = await open(dir);

    // The upload the server would have written before the message reached the engine.
    const id = '11111111-2222-3333-4444-555555555555';
    const path = attachmentPath(engine.room.id, id, '.png');
    mkdirSync(roomAttachmentsDir(engine.room.id), { recursive: true });
    writeFileSync(path, 'not really a png');

    engine.postUserMessage('Why does it look like this?', {
      mention: 'echo',
      attachments: [
        { id, name: 'screenshot.png', mime: 'image/png', size: 16, kind: 'image', path },
      ],
    });
    engine.resume();
    await engine.run({ askedByYou: true });

    const prompt = workerPrompt();
    expect(prompt).toContain('Attached, on disk');
    expect(prompt).toContain(path);
    expect(prompt).toContain('screenshot.png');

    // Without the folder as an extra root, a sandboxed CLI could not open the path above.
    const request = requests.find((r) => r.prompt.includes('as WORKER'))!;
    expect(request.additionalDirs).toContain(roomAttachmentsDir(engine.room.id));
  });

  it('attaches another room"s transcript when you reference it', async () => {
    script([{ when: { role: 'worker', round: 1 }, text: 'Read it.' }]);
    const source = await open(repo(), 'The auth spike.');
    source.postUserMessage('we settled on cookies');

    const target = await open(repo());
    const message = target.postUserMessage('Follow what we decided there.', {
      mention: 'echo',
      rooms: [source.room.slug],
    });

    expect(message.attachments).toHaveLength(1);
    const attached = message.attachments[0]!;
    expect(attached.kind).toBe('room');
    expect(attached.roomRef?.id).toBe(source.room.id);
    expect(existsSync(attached.path)).toBe(true);

    target.resume();
    await target.run({ askedByYou: true });

    const prompt = workerPrompt();
    expect(prompt).toContain('transcript of room');
    expect(prompt).toContain(source.room.slug);
    expect(prompt).toContain(attached.path);
  });

  it('says so in the transcript when a referenced room does not exist', async () => {
    const engine = await open(repo());
    const message = engine.postUserMessage('see #nope', { rooms: ['nope'] });

    expect(message.attachments).toHaveLength(0);
    expect(
      store
        .listMessages(engine.room.id)
        .some((m) => m.kind === 'system' && m.text.includes('no room matches "nope"')),
    ).toBe(true);
  });

  it('keeps a room from attaching its own transcript to itself', async () => {
    const engine = await open(repo());
    const message = engine.postUserMessage('see this room', { rooms: [engine.room.id] });
    expect(message.attachments).toHaveLength(0);
  });

  it('takes the attachment folder with the room when it is deleted', async () => {
    const engine = await open(repo());
    const dir = roomAttachmentsDir(engine.room.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'leftover.png'), 'x');

    store.deleteRoom(engine.room.id);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('a round you asked for that changed nothing', () => {
  it('does not buy every reviewer a turn to say there is no diff', async () => {
    const dir = repo();
    script([{ when: { role: 'worker', round: 1 }, text: 'It works like this because…' }]);

    const engine = await open(dir);
    engine.postUserMessage('why is it written this way?', { mention: 'echo' });
    engine.resume();
    const outcome = await engine.run({ askedByYou: true });

    expect(outcome.state).toBe('needs-you');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).toContain('as WORKER');
    expect(
      store
        .listMessages(engine.room.id)
        .some((m) => m.kind === 'system' && m.text.includes('not asked to review')),
    ).toBe(true);
  });

  it('still reviews when the worker did change something', async () => {
    const dir = repo();
    script([
      { when: { role: 'worker', round: 1 }, text: 'Fixed.', writeFiles: { 'math.js': FIXED } },
      { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
    ]);

    const engine = await open(dir);
    engine.postUserMessage('just fix it', { mention: 'echo' });
    engine.resume();
    const outcome = await engine.run({ askedByYou: true });

    expect(outcome.state).toBe('approved');
    expect(requests.filter((r) => r.prompt.includes('as REVIEWER'))).toHaveLength(1);
  });

  it('reviews as usual when the round was not one you asked for', async () => {
    const dir = repo();
    script([
      { when: { role: 'worker', round: 1 }, text: 'Nothing to do.' },
      { when: { role: 'reviewer', round: 1 }, text: verdict('question') },
    ]);

    const engine = await open(dir);
    await engine.run();

    expect(requests.filter((r) => r.prompt.includes('as REVIEWER'))).toHaveLength(1);
  });
});

describe('reopening an approved room', () => {
  it('marks the state change as yours, so nothing notifies you about your own typing', async () => {
    const dir = repo();
    script([
      { when: { role: 'worker', round: 1 }, text: 'Fixed.', writeFiles: { 'math.js': FIXED } },
      { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
    ]);

    const engine = await open(dir);
    expect((await engine.run()).state).toBe('approved');

    const events: EngineEvent[] = [];
    engine.subscribe((event) => events.push(event));
    engine.postUserMessage('one more thing', { mention: 'echo' });

    const stateEvents = events.filter(
      (e): e is Extract<EngineEvent, { type: 'room.state' }> => e.type === 'room.state',
    );
    expect(stateEvents.find((e) => e.state === 'needs-you')?.byYou).toBe(true);
  });
});
