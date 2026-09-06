import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { echoAdapter, resetEchoAdapter } from '../../src/adapters/echo.js';
import type { EngineEvent } from '../../src/engine/events.js';
import { RoomEngine, assertRoster } from '../../src/engine/room.js';
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

// `echo3` is never in a room's starting roster; it exists so a test can swap somebody
// out for a runtime the registry knows but the room does not hold.
const adapters = { echo: spy('echo'), echo2: spy('echo2'), echo3: spy('echo3') };

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

function open(dir: string): Promise<RoomEngine> {
  return RoomEngine.create(
    { task: 'fix add()', cwd: dir, agents: ['echo', 'echo2'] },
    { store, adapters, timeoutMs: 5000 },
  );
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

describe('assertRoster', () => {
  it('insists on exactly one worker, who may write, and reviewers who may not', () => {
    const ok = [
      { runtime: 'a', role: 'worker' as const, permission: 'edits' as const },
      { runtime: 'b', role: 'reviewer' as const, permission: 'read-only' as const },
    ];
    expect(() => assertRoster(ok, 'build-review')).not.toThrow();

    expect(() => assertRoster([ok[0]!, { ...ok[1]!, role: 'worker' }], 'build-review')).toThrow(
      /exactly one worker/,
    );
    expect(() => assertRoster([ok[1]!], 'build-review')).toThrow(/exactly one worker/);
    expect(() =>
      assertRoster([{ ...ok[0]!, permission: 'read-only' }, ok[1]!], 'build-review'),
    ).toThrow(/worker needs a writing permission/);
    expect(() =>
      assertRoster([ok[0]!, { ...ok[1]!, permission: 'edits' }], 'build-review'),
    ).toThrow(/must be read-only/);
  });

  it('insists on exactly one moderator and no writers in a brainstorm', () => {
    const ok = [
      { runtime: 'a', role: 'reviewer' as const, permission: 'read-only' as const },
      { runtime: 'b', role: 'moderator' as const, permission: 'read-only' as const },
    ];
    expect(() => assertRoster(ok, 'brainstorm')).not.toThrow();
    expect(() => assertRoster([ok[0]!], 'brainstorm')).toThrow(/exactly one moderator/);
    expect(() => assertRoster([ok[1]!, ok[1]!], 'brainstorm')).toThrow(/exactly one moderator/);
    expect(() => assertRoster([{ ...ok[0]!, permission: 'edits' }, ok[1]!], 'brainstorm')).toThrow(
      /nobody edits/,
    );
    expect(() => assertRoster([{ ...ok[0]!, role: 'worker' }, ok[1]!], 'brainstorm')).toThrow(
      /no "worker"/,
    );
  });
});

describe('RoomEngine.setParticipant', () => {
  it('swaps worker and reviewer in one step, keeping both sessions', async () => {
    const dir = repo();
    script([
      { when: { role: 'worker', round: 1 }, text: 'did a thing', writeFiles: { 'math.js': 'x\n' } },
      // A question parks the room in `needs-you` after one round, with both sessions live.
      { when: { role: 'reviewer', round: 1 }, text: verdict('question') },
    ]);

    const engine = await open(dir);
    await engine.run();

    const before = engine.participants;
    expect(before.map((p) => `${p.runtime}:${p.role}`)).toEqual(['echo:worker', 'echo2:reviewer']);
    // Both agents took a turn, so both carry a runtime session.
    expect(before.every((p) => p.sessionId)).toBe(true);

    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const after = engine.setParticipant('echo2', { role: 'worker' });

    expect(after.map((p) => `${p.runtime}:${p.role}:${p.permission}`)).toEqual([
      'echo:reviewer:read-only',
      'echo2:worker:edits',
    ]);
    // Sessions survive the swap; that is the whole point of swapping rather than reopening.
    for (const participant of after) {
      const was = before.find((p) => p.id === participant.id)!;
      expect(participant.sessionId).toBe(was.sessionId);
    }
    expect(events.filter((e) => e.type === 'room.roster')).toHaveLength(1);
    // The change is in the transcript, not only in a row.
    expect(engine.messages.some((m) => m.kind === 'system' && m.text.includes('now worker'))).toBe(
      true,
    );
  });

  it('carries a role-changed block into the swapped participant next turn, once', async () => {
    const dir = repo();
    script([
      { when: { role: 'worker', round: 1 }, text: 'did a thing', writeFiles: { 'math.js': 'x\n' } },
      { when: { role: 'reviewer', round: 1 }, text: verdict('question') },
      { when: { role: 'worker', round: 2 }, text: 'did another thing' },
      { when: { role: 'reviewer', round: 2 }, text: verdict('request-changes') },
      { when: { role: 'worker', round: 3 }, text: 'and another' },
      { when: { role: 'reviewer', round: 3 }, text: verdict('approve') },
    ]);

    // A question after round 1 lands the room in `needs-you` with both agents holding a
    // session – which is exactly the moment the human swaps.
    const engine = await open(dir);
    await engine.run();
    engine.setParticipant('echo2', { role: 'worker' });

    requests.length = 0;
    await engine.run();

    const swapped = requests.filter((r) => r.prompt.includes('acting as WORKER'));
    expect(swapped.length).toBeGreaterThan(0);
    expect(swapped[0]?.prompt).toContain('## Your role has changed');
    expect(swapped[0]?.prompt).toContain('You were the REVIEWER in this room until now');
    // The round is stated explicitly: the counter does not reset on a swap.
    expect(swapped[0]?.prompt).toMatch(/this is round \d/);
    // The demoted worker is told too – it is now a reviewer with reviewer rules.
    const demoted = requests.find((r) => r.prompt.includes('acting as REVIEWER'));
    expect(demoted?.prompt).toContain('You were the WORKER in this room until now');
    // And not again on the turn after that.
    if (swapped[1]) expect(swapped[1].prompt).not.toContain('## Your role has changed');
  });

  it('changes a model without touching the role, and clears it with null', async () => {
    const engine = await open(repo());
    expect(engine.setParticipant('echo', { model: 'opus' })[0]?.model).toBe('opus');
    expect(engine.participants[0]?.role).toBe('worker');
    expect(engine.setParticipant('echo', { model: null })[0]?.model).toBeNull();
  });

  it('refuses while a turn is in flight, because the child already has its permission', async () => {
    const dir = repo();
    script([
      { when: { role: 'worker', round: 1 }, text: 'working', delayMs: 400 },
      { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
    ]);

    const engine = await open(dir);
    const running = engine.run();
    await new Promise((r) => setTimeout(r, 80));
    expect(() => engine.setParticipant('echo2', { role: 'worker' })).toThrow(/mid-round/);
    await running;
  });

  it('refuses a swap that would leave the room with no worker, or with two', async () => {
    const engine = await open(repo());
    expect(() => engine.setParticipant('echo', { role: 'reviewer' })).toThrow(/exactly one worker/);
    // A brainstorm role has no meaning in a build-review room.
    expect(() => engine.setParticipant('echo2', { role: 'moderator' })).toThrow(
      /only worker and reviewers/,
    );
    expect(() => engine.setParticipant('nobody', { role: 'worker' })).toThrow(/nobody called/);
    expect(() => engine.setParticipant('echo', {})).toThrow(/nothing to change/);
  });
});

describe('RoomEngine.setParticipant replacing a runtime', () => {
  it('swaps the runtime in place, keeping the slot and the role', async () => {
    const dir = repo();
    script([
      { when: { role: 'worker', round: 1 }, text: 'did a thing', writeFiles: { 'math.js': 'x\n' } },
      { when: { role: 'reviewer', round: 1 }, text: verdict('question') },
    ]);
    const engine = await open(dir);
    await engine.run();

    const before = engine.participants.find((p) => p.runtime === 'echo')!;
    expect(before.role).toBe('worker');
    expect(before.sessionId).not.toBeNull();

    const next = engine.setParticipant('echo', { runtime: 'echo3' });

    const after = next.find((p) => p.runtime === 'echo3')!;
    expect(next.map((p) => p.runtime)).toEqual(['echo3', 'echo2']);
    // Same row, same slot, same job: this is a replacement, not a new participant.
    expect(after.id).toBe(before.id);
    expect(after.role).toBe('worker');
    expect(after.permission).toBe(before.permission);
    expect(after.orderIndex).toBe(before.orderIndex);
  });

  it('drops the session, the model and the watermark the old runtime owned', async () => {
    const dir = repo();
    script([
      { when: { role: 'worker', round: 1 }, text: 'did a thing', writeFiles: { 'math.js': 'x\n' } },
      { when: { role: 'reviewer', round: 1 }, text: verdict('question') },
    ]);
    const engine = await open(dir);
    engine.setParticipant('echo', { model: 'some-echo-model' });
    await engine.run();

    const before = engine.participants.find((p) => p.runtime === 'echo')!;
    expect(before.sessionId).not.toBeNull();
    expect(before.lastSeenMessageId).not.toBeNull();

    const after = engine
      .setParticipant('echo', { runtime: 'echo3' })
      .find((p) => p.runtime === 'echo3')!;

    // A session id names a conversation only the old binary can resume, and a model id
    // belongs to the runtime that offered it. Neither survives the swap.
    expect(after.sessionId).toBeNull();
    expect(after.model).toBeNull();
    // The watermark goes too, so the newcomer's first prompt carries the whole transcript
    // rather than the messages since a turn it never took.
    expect(after.lastSeenMessageId).toBeNull();
  });

  it('keeps a model named in the same call, because that one is the new runtime’s', async () => {
    const dir = repo();
    const engine = await open(dir);
    const after = engine
      .setParticipant('echo', { runtime: 'echo3', model: 'echo3-model' })
      .find((p) => p.runtime === 'echo3')!;
    expect(after.model).toBe('echo3-model');
  });

  it('refuses a runtime acr does not know, or one already in the room', async () => {
    const dir = repo();
    const engine = await open(dir);
    expect(() => engine.setParticipant('echo', { runtime: 'nope' })).toThrow(/unknown runtime/);
    // A roster may already hold a runtime twice (`--agents echo,echo` is a legal room), but
    // a swap will not create that situation: two participants under one name are what an
    // `@mention` cannot tell apart.
    expect(() => engine.setParticipant('echo', { runtime: 'echo2' })).toThrow(
      /already in this room/,
    );
  });

  it('refuses mid-round, exactly like a role or model change', async () => {
    const dir = repo();
    script([{ when: { role: 'worker', round: 1 }, delayMs: 3000, text: 'slow' }]);
    const engine = await open(dir);
    const running = engine.run();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => engine.setParticipant('echo', { runtime: 'echo3' })).toThrow(/mid-round/);
    engine.stop('stopped by test');
    await running;
  });

  it('addresses the right slot when the roster holds a runtime twice', async () => {
    // `--agents echo,echo` is a legal room, and then a runtime id names two participants.
    // The row id is the handle that can tell them apart; the web panel sends that one.
    const engine = await RoomEngine.create(
      { task: 'fix add()', cwd: repo(), agents: ['echo', 'echo'] },
      { store, adapters, timeoutMs: 5000 },
    );
    const [first, second] = engine.participants;
    expect(first!.runtime).toBe('echo');
    expect(second!.runtime).toBe('echo');

    const next = engine.setParticipant(second!.id, { runtime: 'echo3' });

    // The reviewer was replaced, not the worker a bare runtime lookup would have found.
    expect(next.map((p) => `${p.runtime}:${p.role}`)).toEqual(['echo:worker', 'echo3:reviewer']);
  });

  it('moves an @mention off the runtime that just left', async () => {
    const dir = repo();
    const engine = await open(dir);
    engine.postUserMessage('over to you', { mention: 'echo' });
    expect(engine.room.nextSpeaker).toBe('echo');

    engine.setParticipant('echo', { runtime: 'echo3' });
    // Otherwise the next turn would be routed to somebody who is no longer in the room.
    expect(engine.room.nextSpeaker).toBe('echo3');
  });
});
