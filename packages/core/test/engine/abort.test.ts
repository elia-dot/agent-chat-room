import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { echoAdapter, resetEchoAdapter } from '../../src/adapters/echo.js';
import { RoomEngine } from '../../src/engine/room.js';
import { RoomStore } from '../../src/store/rooms.js';
import type { AgentAdapter } from '../../src/types.js';
import { makeRepo, useTempConfigDir, writeEchoScript } from '../helpers.js';

let config: ReturnType<typeof useTempConfigDir>;
let store: RoomStore;
const repos: string[] = [];

/**
 * A turn that *throws* rather than one that fails.
 *
 * The distinction is the whole subject of this file: a failed turn is an ordinary outcome
 * the engine already reports, while a throw is a bug or a dead database, and the question
 * is whether the room survives it or is stranded mid-round with no way back but a restart.
 */
const exploding = (id: string): AgentAdapter => ({
  ...echoAdapter,
  id,
  run() {
    throw new Error(`${id} exploded`);
  },
});

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

beforeEach(() => {
  config = useTempConfigDir();
  process.env.ACR_NO_TURN_LOG = '1';
  store = RoomStore.open();
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

describe('a turn that throws', () => {
  it('aborts the round instead of stranding the room in `running`', async () => {
    const dir = repo();
    script([
      { when: { role: 'worker', round: 1 }, text: 'did it', writeFiles: { 'math.js': 'x\n' } },
    ]);
    const engine = await RoomEngine.create(
      { task: 'fix add()', cwd: dir, agents: ['echo', 'boom'] },
      { store, adapters: { echo: echoAdapter, boom: exploding('boom') }, timeoutMs: 5000 },
    );

    const outcome = await engine.run();

    expect(outcome.state).toBe('needs-you');
    expect(outcome.error).toContain('boom exploded');
    // `running` here would mean the only way back is restarting the process.
    expect(engine.room.state).toBe('needs-you');
    expect(engine.room.round).toBe(0);
  });

  it('deletes the half-finished round it rewinds, so Continue does not double it', async () => {
    const dir = repo();
    script([
      { when: { role: 'worker', round: 1 }, text: 'did it', writeFiles: { 'math.js': 'x\n' } },
    ]);
    const engine = await RoomEngine.create(
      { task: 'fix add()', cwd: dir, agents: ['echo', 'boom'] },
      { store, adapters: { echo: echoAdapter, boom: exploding('boom') }, timeoutMs: 5000 },
    );

    await engine.run();

    // The worker's message and diff for round 1 were already posted when the reviewer threw.
    // Leaving them behind means round 1 runs again on top of itself.
    const agentMessages = engine.messages.filter((m) => m.kind === 'agent');
    expect(agentMessages).toEqual([]);
    // The task survives: it is round 0, not part of the round that was abandoned.
    expect(engine.messages.some((m) => m.kind === 'user')).toBe(true);
    // And the explanation survives, because it is written after the delete rather than
    // swept away with the round it describes.
    expect(engine.messages.some((m) => m.kind === 'system' && /aborted/.test(m.text))).toBe(true);
  });

  it('aborts a brainstorm phase too, not only a build round', async () => {
    const dir = repo();
    const engine = await RoomEngine.create(
      { task: 'how should we do X?', cwd: dir, agents: ['echo', 'boom'], mode: 'brainstorm' },
      { store, adapters: { echo: echoAdapter, boom: exploding('boom') }, timeoutMs: 5000 },
    );

    const outcome = await engine.run();

    // The brainstorm fan-out used to be `Promise.all`, so the other speaker's rejection went
    // unobserved – which Node answers by killing the process – and the room stayed `running`.
    expect(outcome.state).toBe('needs-you');
    expect(engine.room.state).toBe('needs-you');
    expect(outcome.error).toContain('boom exploded');
  });

  it('hands back a direct turn that throws, without touching the round counter', async () => {
    const dir = repo();
    script([
      { when: { role: 'worker', round: 1 }, text: 'did it', writeFiles: { 'math.js': 'x\n' } },
      { when: { role: 'reviewer', round: 1 }, text: verdict('question') },
    ]);
    const engine = await RoomEngine.create(
      { task: 'fix add()', cwd: dir, agents: ['echo', 'echo2'] },
      {
        store,
        adapters: { echo: echoAdapter, echo2: { ...echoAdapter, id: 'echo2' } },
        timeoutMs: 5000,
      },
    );
    await engine.run();
    const roundBefore = engine.room.round;
    const messagesBefore = engine.messages.length;

    // Swap in an adapter that throws, and address it directly the way `@mention` does.
    const broken = await RoomEngine.load(engine.room.id, {
      store,
      adapters: { echo: exploding('echo'), echo2: { ...echoAdapter, id: 'echo2' } },
      timeoutMs: 5000,
    });
    const outcome = await broken.run({ directTurn: 'echo' });

    expect(outcome.state).toBe('needs-you');
    expect(outcome.error).toContain('echo exploded');
    // A direct turn is a side conversation: it consumes no round, so aborting one must not
    // rewind the counter or delete the transcript of a round it did not create.
    expect(broken.room.round).toBe(roundBefore);
    expect(broken.messages.length).toBeGreaterThanOrEqual(messagesBefore);
  });

  it('still refuses an unknown name as the caller’s mistake, not an aborted room', async () => {
    const dir = repo();
    const engine = await RoomEngine.create(
      { task: 'fix add()', cwd: dir, agents: ['echo', 'echo2'] },
      {
        store,
        adapters: { echo: echoAdapter, echo2: { ...echoAdapter, id: 'echo2' } },
        timeoutMs: 5000,
      },
    );

    // Resolved before the guard: nothing has started, so there is nothing to abort and the
    // caller gets a usage error rather than a room quietly parked in `needs-you`.
    await expect(engine.run({ directTurn: 'nobody' })).rejects.toThrow(/nobody called/);
    expect(engine.room.state).not.toBe('needs-you');
  });
});
