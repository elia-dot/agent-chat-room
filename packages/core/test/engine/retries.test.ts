import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { echoAdapter, resetEchoAdapter } from '../../src/adapters/echo.js';
import { RoomEngine } from '../../src/engine/room.js';
import { RoomStore } from '../../src/store/rooms.js';
import type { AgentAdapter, TurnRequest } from '../../src/types.js';
import { makeRepo, useTempConfigDir, writeEchoScript } from '../helpers.js';

let config: ReturnType<typeof useTempConfigDir>;
let store: RoomStore;
const repos: string[] = [];
const requests: TurnRequest[] = [];

const spy = (id: string): AgentAdapter => ({
  ...echoAdapter,
  id,
  run(req, sink) {
    requests.push(req);
    return echoAdapter.run(req, sink);
  },
});

const adapters = { echo: spy('echo'), echo2: spy('echo2') };

const verdict = (decision: string): string =>
  `Review body.\n\n\`\`\`verdict\n${JSON.stringify({ decision, blocking: [], nits: [] })}\n\`\`\``;

function repo(): string {
  const dir = makeRepo({ 'math.js': 'export const add = (a, b) => a - b;\n' });
  repos.push(dir);
  return dir;
}

function script(turns: unknown[]): void {
  process.env.ACR_ECHO_SCRIPT = writeEchoScript({ turns });
}

function open(dir: string, maxTurnRetries?: number): Promise<RoomEngine> {
  return RoomEngine.create(
    {
      task: 'fix add()',
      cwd: dir,
      agents: ['echo', 'echo2'],
      ...(maxTurnRetries === undefined ? {} : { maxTurnRetries }),
    },
    // Zero backoff: the retry pause is real behaviour, not something to sit through 20
    // times per suite run.
    { store, adapters, timeoutMs: 5000, retryBackoffMs: 0 },
  );
}

/** Turns taken by the worker, which is how many attempts a retry actually produced. */
function workerTurns(engine: RoomEngine): number {
  return store.listTurns(engine.room.id).filter((t) => t.role === 'worker').length;
}

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

describe('the retry budget', () => {
  it('defaults to 0, which is the behaviour rooms always had', async () => {
    const dir = repo();
    const engine = await open(dir);
    expect(engine.room.maxTurnRetries).toBe(0);

    script([{ when: { role: 'worker', round: 1 }, error: 'boom' }]);
    const outcome = await engine.run();

    expect(outcome.state).toBe('needs-you');
    expect(outcome.error).toContain('boom');
    // Exactly one attempt: a failure with no budget hands the room straight over.
    expect(workerTurns(engine)).toBe(1);
  });

  it('retries a failed worker turn and carries on when a later attempt succeeds', async () => {
    const dir = repo();
    const engine = await open(dir, 2);
    expect(engine.room.maxTurnRetries).toBe(2);

    // The echo adapter consumes scripted turns in order, so the first worker turn fails and
    // the retry picks up the next one.
    script([
      { when: { role: 'worker', round: 1 }, error: 'transient blip' },
      {
        when: { role: 'worker', round: 1 },
        text: 'fixed it',
        writeFiles: { 'math.js': 'export const add = (a, b) => a + b;\n' },
      },
      { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
    ]);

    const outcome = await engine.run();

    expect(outcome.state).toBe('approved');
    // Two attempts, both recorded: a retry must not hide the failure it papered over.
    expect(workerTurns(engine)).toBe(2);
    const turns = store.listTurns(engine.room.id).filter((t) => t.role === 'worker');
    expect(turns[0]?.ok).toBe(false);
    expect(turns[1]?.ok).toBe(true);
  });

  it('says in the transcript that it is retrying, and which attempt it is on', async () => {
    const dir = repo();
    const engine = await open(dir, 1);
    script([
      { when: { role: 'worker', round: 1 }, error: 'transient blip' },
      { when: { role: 'worker', round: 1 }, text: 'ok', writeFiles: { 'math.js': 'x\n' } },
      { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
    ]);

    await engine.run();

    const system = engine.messages.filter((m) => m.kind === 'system').map((m) => m.text);
    expect(system.some((t) => /attempt 1 of 2.*transient blip.*retrying/s.test(t))).toBe(true);
  });

  it('gives up after the budget and hands the room over with the last error', async () => {
    const dir = repo();
    const engine = await open(dir, 2);
    script([
      { when: { role: 'worker', round: 1 }, error: 'first' },
      { when: { role: 'worker', round: 1 }, error: 'second' },
      { when: { role: 'worker', round: 1 }, error: 'third' },
    ]);

    const outcome = await engine.run();

    expect(outcome.state).toBe('needs-you');
    expect(outcome.error).toContain('third');
    // Budget 2 means three attempts in total: the original plus two retries.
    expect(workerTurns(engine)).toBe(3);
    // The round counter is still rewound, so Continue retries this round rather than
    // skipping past it. Retrying changes how many attempts a round gets, not what a
    // failed round means.
    expect(engine.room.round).toBe(0);
  });

  it('retries a reviewer too, not just the worker', async () => {
    const dir = repo();
    const engine = await open(dir, 1);
    script([
      { when: { role: 'worker', round: 1 }, text: 'did it', writeFiles: { 'math.js': 'x\n' } },
      { when: { role: 'reviewer', round: 1 }, error: 'reviewer blip' },
      { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
    ]);

    const outcome = await engine.run();

    expect(outcome.state).toBe('approved');
    const reviews = store.listTurns(engine.room.id).filter((t) => t.role === 'reviewer');
    expect(reviews).toHaveLength(2);
    expect(reviews[0]?.ok).toBe(false);
  });

  it('can be changed while the room is open, and the next round obeys the new value', async () => {
    const dir = repo();
    const engine = await open(dir);
    expect(engine.room.maxTurnRetries).toBe(0);

    store.updateRoom(engine.room.id, { maxTurnRetries: 1 });
    engine.reload();

    script([
      { when: { role: 'worker', round: 1 }, error: 'blip' },
      { when: { role: 'worker', round: 1 }, text: 'ok', writeFiles: { 'math.js': 'x\n' } },
      { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
    ]);

    const outcome = await engine.run();
    expect(outcome.state).toBe('approved');
    expect(workerTurns(engine)).toBe(2);
  });

  it('obeys a budget lowered while the failing turn is still running', async () => {
    const dir = repo();
    const engine = await open(dir, 3);
    script([
      { when: { role: 'worker', round: 1 }, delayMs: 200, error: 'slow failure' },
      { when: { role: 'worker', round: 1 }, text: 'would be a paid retry' },
    ]);

    const running = engine.run();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // "Stop spending" has to mean exactly that, even mid-attempt.
    store.updateRoom(engine.room.id, { maxTurnRetries: 0 });
    const outcome = await running;

    expect(outcome.state).toBe('needs-you');
    expect(workerTurns(engine)).toBe(1);
  });

  it('obeys a budget lowered during the backoff between attempts', async () => {
    const dir = repo();
    const engine = await RoomEngine.create(
      { task: 'fix add()', cwd: dir, agents: ['echo', 'echo2'], maxTurnRetries: 3 },
      { store, adapters, timeoutMs: 5000, retryBackoffMs: 300 },
    );
    script([
      { when: { role: 'worker', round: 1 }, error: 'instant failure' },
      { when: { role: 'worker', round: 1 }, text: 'would be a paid retry' },
    ]);

    const running = engine.run();
    // The first attempt fails at once, so by now the engine is sleeping out the backoff.
    await new Promise((resolve) => setTimeout(resolve, 100));
    store.updateRoom(engine.room.id, { maxTurnRetries: 0 });
    const outcome = await running;

    expect(outcome.state).toBe('needs-you');
    expect(workerTurns(engine)).toBe(1);
  });

  it('does not retry a turn the human stopped', async () => {
    const dir = repo();
    const engine = await open(dir, 3);
    script([
      { when: { role: 'worker', round: 1 }, delayMs: 5000, text: 'never gets here' },
      { when: { role: 'worker', round: 1 }, text: 'would be the retry' },
    ]);

    const running = engine.run();
    // Let the turn start before pulling it out from under itself.
    await new Promise((resolve) => setTimeout(resolve, 50));
    engine.stop('stopped by you');
    const outcome = await running;

    expect(outcome.state).toBe('stopped');
    // One attempt. Retrying a turn the human cancelled would be arguing with them.
    expect(workerTurns(engine)).toBe(1);
  });

  it('keeps the messages a failed turn never saw, so the retry still has them', async () => {
    const dir = repo();
    const engine = await open(dir, 1);
    script([
      { when: { role: 'worker', round: 1 }, error: 'died before reading anything' },
      { when: { role: 'worker', round: 1 }, text: 'ok', writeFiles: { 'math.js': 'x\n' } },
      { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
    ]);

    await engine.run();

    // Both worker attempts must carry the task. A watermark advanced by the failed attempt
    // would have emptied the retry's prompt of everything it had not already seen.
    const workerPrompts = requests.filter((r) => r.prompt.includes('acting as WORKER'));
    expect(workerPrompts).toHaveLength(2);
    for (const request of workerPrompts) expect(request.prompt).toContain('fix add()');
  });
});
