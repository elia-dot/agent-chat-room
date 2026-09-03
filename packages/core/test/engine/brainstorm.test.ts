import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { echoAdapter, resetEchoAdapter } from '../../src/adapters/echo.js';
import { RoomEngine } from '../../src/engine/room.js';
import { RoomStore } from '../../src/store/rooms.js';
import type { AgentAdapter, TurnRequest } from '../../src/types.js';
import { gitIn, makeRepo, useTempConfigDir, writeEchoScript } from '../helpers.js';

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

/** Three distinct runtime ids, all backed by the echo double. */
const adapters = { echo: spy('echo'), echo2: spy('echo2'), echo3: spy('echo3') };

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
    {
      task: 'How should we restructure the pricing module?',
      cwd: dir,
      mode: 'brainstorm',
      agents: ['echo', 'echo2', 'echo3'],
    },
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

describe('RoomEngine, brainstorm mode', () => {
  it('runs answer, react and merge, then hands the room back to you', async () => {
    const dir = repo();
    script([
      { when: { round: 1, runtime: 'echo' }, text: 'Split it by billing period.' },
      { when: { round: 1, runtime: 'echo2' }, text: 'Split it by customer tier.' },
      { when: { round: 1, runtime: 'echo3' }, text: 'Leave it and add tests.' },
      { when: { round: 2, runtime: 'echo' }, text: 'echo2 is right about tiers.' },
      { when: { round: 2, runtime: 'echo2' }, text: 'Agreed with echo about periods too.' },
      { when: { round: 2, runtime: 'echo3' }, text: 'Both work; tests first.' },
      { when: { round: 3, runtime: 'echo3' }, text: 'Proposed task: split by tier, tests first.' },
    ]);

    const engine = await open(dir);
    const outcome = await engine.run();

    expect(outcome.mode).toBe('brainstorm');
    expect(outcome.state).toBe('needs-you');
    expect(outcome.approved).toBe(false);
    expect(outcome.round).toBe(3);

    const agentMessages = engine.messages.filter((m) => m.kind === 'agent');
    expect(agentMessages.filter((m) => m.round === 1)).toHaveLength(3);
    expect(agentMessages.filter((m) => m.round === 2)).toHaveLength(3);

    // Round 3 is the moderator alone – the last runtime in the roster.
    const merge = agentMessages.filter((m) => m.round === 3);
    expect(merge).toHaveLength(1);
    expect(merge[0]?.author).toBe('echo3');
    expect(merge[0]?.role).toBe('moderator');
  });

  it('gives every participant its phase instructions, and the moderator the merge ones', async () => {
    const dir = repo();
    script([
      { when: { round: 1 }, text: 'a' },
      { when: { round: 1 }, text: 'b' },
      { when: { round: 1 }, text: 'c' },
      { when: { round: 2 }, text: 'd' },
      { when: { round: 2 }, text: 'e' },
      { when: { round: 2 }, text: 'f' },
      { when: { round: 3 }, text: 'Proposed task: do the thing.' },
    ]);

    const engine = await open(dir);
    await engine.run();

    const answer = requests.filter((r) => r.prompt.includes('(round 1)'));
    expect(answer).toHaveLength(3);
    for (const req of answer) {
      expect(req.systemAppend).toContain('thinking out loud, in parallel');
      // Nobody reviews here, so nothing should ask for a verdict block.
      expect(req.prompt).not.toContain('```verdict');
      expect(req.permission).toBe('read-only');
    }

    const react = requests.filter((r) => r.prompt.includes('(round 2)'));
    expect(react).toHaveLength(3);
    expect(react[0]?.systemAppend).toContain('This is your one turn to react');
    // The answers from round 1 reach round 2 through the ordinary unseen-messages path.
    expect(react.some((r) => r.prompt.includes('## New messages since your last turn'))).toBe(true);

    const merge = requests.filter((r) => r.prompt.includes('(round 3)'));
    expect(merge).toHaveLength(1);
    expect(merge[0]?.prompt).toContain('acting as MODERATOR');
    expect(merge[0]?.systemAppend).toContain('merged proposal');
  });

  it('commits nothing and parses no verdict, because nobody edits or reviews', async () => {
    const dir = repo();
    script([
      { when: { round: 1 }, text: 'a' },
      { when: { round: 1 }, text: 'b' },
      { when: { round: 1 }, text: 'c' },
      { when: { round: 2 }, text: 'd' },
      { when: { round: 2 }, text: 'e' },
      { when: { round: 2 }, text: 'f' },
      // Even a stray verdict block must not be read as an approval in this mode.
      {
        when: { round: 3 },
        text: 'Proposal.\n\n```verdict\n{"decision":"approve","blocking":[],"nits":[]}\n```',
      },
    ]);

    const engine = await open(dir);
    const outcome = await engine.run();

    expect(outcome.state).toBe('needs-you');
    expect(outcome.commit).toBeUndefined();
    expect(engine.messages.every((m) => m.verdict === null)).toBe(true);
    expect(engine.messages.every((m) => m.diff === null)).toBe(true);

    // The worktree exists (uniformly, and plan mode still wants a repo to read) but the
    // room branch has no commits of its own beyond the one it was cut from.
    const worktree = engine.room.worktreePath!;
    expect(gitIn(worktree, 'log', '--oneline').split('\n')).toHaveLength(1);
  });

  it('makes the roster legal by construction: one moderator, nobody with write access', async () => {
    const engine = await open(repo());
    const roster = engine.participants;
    expect(roster.map((p) => p.role)).toEqual(['reviewer', 'reviewer', 'moderator']);
    expect(roster.every((p) => p.permission === 'read-only')).toBe(true);
    expect(engine.room.maxRounds).toBe(3);
  });

  it('exposes the moderator proposal, and nothing before there is one', async () => {
    const dir = repo();
    script([
      { when: { round: 1 }, text: 'a' },
      { when: { round: 1 }, text: 'b' },
      { when: { round: 1 }, text: 'c' },
      { when: { round: 2 }, text: 'd' },
      { when: { round: 2 }, text: 'e' },
      { when: { round: 2 }, text: 'f' },
      { when: { round: 3 }, text: 'Proposed task: split by tier.' },
    ]);

    const engine = await open(dir);
    expect(engine.proposal()).toBeUndefined();
    await engine.run();
    expect(engine.proposal()?.text).toContain('Proposed task: split by tier.');
  });

  it('refuses a brainstorm room with fewer than two participants', async () => {
    await expect(
      RoomEngine.create(
        { task: 'think', cwd: repo(), mode: 'brainstorm', agents: ['echo'] },
        { store, adapters, timeoutMs: 5000 },
      ),
    ).rejects.toThrow(/at least two participants/);
  });
});
