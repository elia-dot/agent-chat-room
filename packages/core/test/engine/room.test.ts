import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { echoAdapter, resetEchoAdapter } from '../../src/adapters/echo.js';
import { RoomEngine } from '../../src/engine/room.js';
import type { EngineEvent } from '../../src/engine/events.js';
import { RoomStore } from '../../src/store/rooms.js';
import type { AgentAdapter, TurnRequest } from '../../src/types.js';
import { gitIn, makeRepo, useTempConfigDir, writeEchoScript } from '../helpers.js';

const BROKEN = 'export function add(a, b) {\n  return a - b;\n}\n';
const HALF = 'export function add(a, b) {\n  return a + b; // no test yet\n}\n';
const FIXED = 'export function add(a, b) {\n  return a + b;\n}\n';

const verdict = (decision: string, blocking: string[] = []): string =>
  `Review body.\n\n\`\`\`verdict\n${JSON.stringify({ decision, blocking, nits: [] })}\n\`\`\``;

let config: ReturnType<typeof useTempConfigDir>;
let store: RoomStore;
const repos: string[] = [];
const requests: TurnRequest[] = [];

/** The echo adapter, wrapped so a test can see what each turn was actually asked. */
const spyEcho: AgentAdapter = {
  ...echoAdapter,
  capabilities: { ...echoAdapter.capabilities, structuredOutput: true },
  run(req, sink) {
    requests.push(req);
    return echoAdapter.run(req, sink);
  },
};

function repo(): string {
  const dir = makeRepo({ 'math.js': BROKEN });
  repos.push(dir);
  return dir;
}

function script(turns: unknown[]): void {
  process.env.ACR_ECHO_SCRIPT = writeEchoScript({ turns });
}

/** A second runtime id backed by the same double, so an @mention can name a reviewer. */
const spyEcho2: AgentAdapter = {
  ...spyEcho,
  id: 'echo2',
  run: (req, sink) => spyEcho.run(req, sink),
};

function engineOptions(): Parameters<typeof RoomEngine.create>[1] {
  return { store, adapters: { echo: spyEcho, echo2: spyEcho2 }, timeoutMs: 5000 };
}

function open(dir: string, reviewers = 1): Promise<RoomEngine> {
  return RoomEngine.create(
    {
      task: 'math.js exports add() but the body subtracts. Fix it.',
      cwd: dir,
      agents: ['echo', ...Array<string>(reviewers).fill('echo')],
    },
    engineOptions(),
  );
}

const workerTurn = (round: number, text: string, files?: Record<string, string>) => ({
  when: { role: 'worker', round },
  text,
  ...(files ? { writeFiles: files } : {}),
});

const reviewTurn = (round: number, text: string) => ({ when: { role: 'reviewer', round }, text });

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

describe('RoomEngine, the build-review loop', () => {
  it('approves on round 1 and commits the round on the room branch', async () => {
    const dir = repo();
    script([
      workerTurn(1, 'Swapped the operator in math.js.', { 'math.js': FIXED }),
      reviewTurn(1, verdict('approve')),
    ]);

    const engine = await open(dir);
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const outcome = await engine.run();

    expect(outcome.state).toBe('approved');
    expect(outcome.approved).toBe(true);
    expect(outcome.round).toBe(1);
    expect(outcome.changedFiles).toEqual(['math.js']);
    expect(outcome.commit).toBeTruthy();

    const worktree = engine.room.worktreePath!;
    // The room edited its worktree; the human's checkout never moved.
    expect(readFileSync(join(worktree, 'math.js'), 'utf8')).toBe(FIXED);
    expect(readFileSync(join(dir, 'math.js'), 'utf8')).toBe(BROKEN);

    // One commit on acr/<slug>, with the worker's summary as the body.
    expect(engine.room.roomBranch).toMatch(/^acr\//);
    expect(gitIn(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(engine.room.roomBranch);
    const log = gitIn(worktree, 'log', '-1', '--pretty=%s%n%b');
    expect(log).toContain('acr: ');
    expect(log).toContain('Swapped the operator in math.js.');
    expect(gitIn(worktree, 'rev-list', '--count', 'HEAD')).toBe('2');

    // The event stream is the one M2's WebSocket forwards.
    expect(events.filter((e) => e.type === 'room.state').map((e) => e.state)).toEqual([
      'running',
      'waiting-reviews',
      'approved',
    ]);
    expect(events.some((e) => e.type === 'message.delta')).toBe(true);
    expect(events.some((e) => e.type === 'message.done')).toBe(true);

    // And everything is persisted.
    const room = store.getRoom(engine.room.id)!;
    expect(room.state).toBe('approved');
    expect(store.listTurns(room.id)).toHaveLength(2);
    expect(store.unfinishedTurns(room.id)).toHaveLength(0);
    expect(
      requests.find((request) => request.prompt.includes('acting as WORKER'))?.outputSchema,
    ).toBe(undefined);
    expect(
      requests.find((request) => request.prompt.includes('acting as REVIEWER'))?.outputSchema,
    ).toBeDefined();
    expect(
      store.listMessages(room.id).some((m) => m.kind === 'system' && m.text.includes('committed')),
    ).toBe(true);
  });

  it('runs a second round on request-changes, carrying the blocking items and resuming', async () => {
    const dir = repo();
    script([
      workerTurn(1, 'First pass.', { 'math.js': HALF }),
      reviewTurn(1, verdict('request-changes', ['math.js:2 drop the stray comment'])),
      workerTurn(2, 'Dropped the comment.', { 'math.js': FIXED }),
      reviewTurn(2, verdict('approve')),
    ]);

    const engine = await open(dir);
    const outcome = await engine.run();

    expect(outcome.state).toBe('approved');
    expect(outcome.round).toBe(2);

    // Round 2's worker prompt carries the reviewer's blocking item, not the whole transcript.
    const workerRound2 = requests[2]!;
    expect(workerRound2.prompt).toContain('(round 2)');
    expect(workerRound2.prompt).toContain('math.js:2 drop the stray comment');
    expect(workerRound2.prompt).toContain('verdict: request-changes');
    expect(workerRound2.prompt).not.toContain('First pass.');

    // It resumed rather than starting cold, and it is the same session as round 1.
    expect(requests[0]!.sessionId).toBeUndefined();
    expect(workerRound2.sessionId).toBeTruthy();
    expect(workerRound2.sessionId).toBe(
      requests[0] && store.listTurns(engine.room.id)[0]?.sessionId,
    );

    const turns = store.listTurns(engine.room.id);
    expect(turns).toHaveLength(4);
    expect(turns.filter((t) => t.round === 2)).toHaveLength(2);
    expect(gitIn(engine.room.worktreePath!, 'rev-list', '--count', 'HEAD')).toBe('2');
  });

  it('needs every reviewer, not a majority', async () => {
    const dir = repo();
    script([
      workerTurn(1, 'First pass.', { 'math.js': HALF }),
      { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
      {
        when: { role: 'reviewer', round: 1 },
        text: verdict('request-changes', ['math.js:2 nope']),
      },
      workerTurn(2, 'Fixed.', { 'math.js': FIXED }),
      { when: { role: 'reviewer', round: 2 }, text: verdict('approve') },
      { when: { role: 'reviewer', round: 2 }, text: verdict('approve') },
    ]);

    const engine = await open(dir, 2);
    const outcome = await engine.run();

    expect(outcome.round).toBe(2);
    expect(outcome.state).toBe('approved');
    const tally = store
      .listMessages(engine.room.id)
      .filter((m) => m.kind === 'system' && m.text.includes('approved.'))
      .map((m) => m.text);
    expect(tally[0]).toContain('1 of 2 approved');
    expect(tally[1]).toContain('2 of 2 approved');
  });

  it('has no round budget: request-changes keeps the loop going until an approval', async () => {
    const dir = repo();
    script([
      workerTurn(1, 'Attempt 1.', { 'math.js': HALF }),
      reviewTurn(1, verdict('request-changes', ['math.js:2 still wrong'])),
      workerTurn(2, 'Attempt 2.', { 'math.js': HALF }),
      reviewTurn(2, verdict('request-changes', ['math.js:2 still still wrong'])),
      workerTurn(3, 'Attempt 3.', { 'math.js': FIXED }),
      reviewTurn(3, verdict('approve')),
    ]);

    const engine = await open(dir);
    const outcome = await engine.run();

    // The room never parked itself: the only things that end a build loop are an
    // approval, a question, a failure, or the human pausing or stopping it.
    expect(outcome.state).toBe('approved');
    expect(outcome.round).toBe(3);
    expect(outcome.commit).toBeTruthy();
    expect(
      store
        .listMessages(engine.room.id)
        .some((m) => m.kind === 'system' && m.text.includes('stopping after')),
    ).toBe(false);
    expect(readFileSync(join(engine.room.worktreePath!, 'math.js'), 'utf8')).toBe(FIXED);
  });

  it('never guesses an approval from a review with no verdict block', async () => {
    const dir = repo();
    script([
      workerTurn(1, 'Done.', { 'math.js': FIXED }),
      reviewTurn(1, 'Looks good to me, ship it.'),
      workerTurn(2, 'Nothing to change.'),
      reviewTurn(2, verdict('approve')),
    ]);

    const engine = await open(dir);
    const outcome = await engine.run();

    // Round 1 counted as not approved, so a second round ran before the approval.
    expect(outcome.state).toBe('approved');
    expect(outcome.round).toBe(2);
    const note = store
      .listMessages(engine.room.id)
      .find((m) => m.kind === 'system' && m.text.includes('did not end with a verdict block'))!;
    expect(note.text).toContain('Counting it as not approved');
    // The tail is quoted so the human can tell a formatting slip from a refusal.
    expect(note.text).toContain('Looks good to me, ship it.');
  });

  it('stops for the human as soon as a reviewer asks a question', async () => {
    const dir = repo();
    script([
      workerTurn(1, 'Done.', { 'math.js': FIXED }),
      reviewTurn(1, verdict('question', [])),
      workerTurn(2, 'should never run', { 'math.js': BROKEN }),
    ]);

    const engine = await open(dir);
    const outcome = await engine.run();

    expect(outcome.state).toBe('needs-you');
    expect(outcome.round).toBe(1);
    // Round 2 never started: a question is addressed to the human, not to the worker.
    expect(store.listTurns(engine.room.id).every((t) => t.round === 1)).toBe(true);
  });

  it('reopens an approved room when the human names an agent, and runs again', async () => {
    const dir = repo();
    script([
      workerTurn(1, 'Done.', { 'math.js': FIXED }),
      reviewTurn(1, verdict('approve')),
      workerTurn(2, 'Fixed the CI failure too.', { 'math.js': FIXED }),
      reviewTurn(2, verdict('approve')),
    ]);

    const engine = await open(dir);
    expect((await engine.run()).state).toBe('approved');

    // Approved is terminal on its own: nothing runs, and no turn is spent.
    const turnsWhenApproved = store.listTurns(engine.room.id).length;
    expect((await engine.run()).state).toBe('approved');
    expect(store.listTurns(engine.room.id)).toHaveLength(turnsWhenApproved);

    // Naming an agent is the human asking for one more turn, so the room comes back.
    engine.postUserMessage('CI failed on the PR, see why and fix it', { mention: 'echo' });
    expect(engine.room.state).toBe('needs-you');
    expect(
      store
        .listMessages(engine.room.id)
        .some((m) => m.kind === 'system' && m.text.includes('reopened by you')),
    ).toBe(true);

    engine.resume();
    const second = await engine.run();
    expect(second.state).toBe('approved');
    expect(second.round).toBe(2);
    expect(store.listTurns(engine.room.id).length).toBeGreaterThan(turnsWhenApproved);
  });

  it('leaves an approved room finished when the message names nobody', async () => {
    const dir = repo();
    script([workerTurn(1, 'Done.', { 'math.js': FIXED }), reviewTurn(1, verdict('approve'))]);

    const engine = await open(dir);
    expect((await engine.run()).state).toBe('approved');

    engine.postUserMessage('noting this for later');
    expect(engine.room.state).toBe('approved');
  });

  it('stops for the human when a reviewer turn fails, instead of starting another round', async () => {
    const dir = repo();
    script([
      workerTurn(1, 'Done.', { 'math.js': FIXED }),
      { when: { role: 'reviewer', round: 1 }, error: 'You have hit your usage limit' },
      reviewTurn(1, verdict('approve')),
      workerTurn(2, 'should never run', { 'math.js': BROKEN }),
    ]);

    const engine = await open(dir, 2);
    const outcome = await engine.run();

    // One approval and one failure is not an approval, and it is not a worker problem
    // either: without a round budget, another round would just fail the same way.
    expect(outcome.state).toBe('needs-you');
    expect(outcome.error).toContain('usage limit');
    expect(outcome.round).toBe(1);
    expect(store.listTurns(engine.room.id).every((t) => t.round === 1)).toBe(true);
    expect(
      store
        .listMessages(engine.room.id)
        .some((m) => m.kind === 'system' && m.text.includes('waiting for you')),
    ).toBe(true);
  });

  it('reports a failed worker turn instead of reviewing nothing', async () => {
    const dir = repo();
    script([
      { when: { role: 'worker', round: 1 }, error: 'the runtime fell over' },
      reviewTurn(1, verdict('approve')),
    ]);

    const engine = await open(dir);
    const outcome = await engine.run();

    expect(outcome.state).toBe('needs-you');
    expect(outcome.error).toContain('the runtime fell over');
    expect(store.listTurns(engine.room.id)).toHaveLength(1);
  });

  it('runs setup hooks on round 0 and testCommand gatekeeper between worker and reviewer', async () => {
    const dir = repo();
    writeFileSync(
      join(dir, '.acr.json'),
      JSON.stringify({
        setup: ['node -e "process.stdout.write(\'setup ok\')"'],
        testCommand: 'node -e "process.stdout.write(\'gatekeeper tests passed\')"',
      }),
    );
    script([
      workerTurn(1, 'Swapped operator.', { 'math.js': FIXED }),
      reviewTurn(1, verdict('approve')),
    ]);

    const engine = await open(dir);
    const outcome = await engine.run();

    expect(outcome.approved).toBe(true);
    const msgs = store.listMessages(engine.room.id);
    expect(
      msgs.some((m) => m.kind === 'system' && m.text.includes('[setup] completed all steps')),
    ).toBe(true);
    expect(msgs.some((m) => m.kind === 'system' && m.text.includes('[test runner]'))).toBe(true);

    const revReq = requests.find((r) => r.prompt.includes('acting as REVIEWER'));
    expect(revReq).toBeDefined();
    expect(revReq!.prompt).toContain('## Test Results');
    expect(revReq!.prompt).toContain('gatekeeper tests passed');
  });

  it('halts in needs-you when setup fails and does not mark setup completed', async () => {
    const dir = repo();
    writeFileSync(
      join(dir, '.acr.json'),
      JSON.stringify({
        setup: ['node -e "process.exit(1)"'],
      }),
    );
    script([
      workerTurn(1, 'Swapped operator.', { 'math.js': FIXED }),
      reviewTurn(1, verdict('approve')),
    ]);

    const engine = await open(dir);
    const outcome = await engine.run();

    expect(outcome.state).toBe('needs-you');
    expect(outcome.approved).toBe(false);
    const msgs = store.listMessages(engine.room.id);
    expect(
      msgs.some((m) => m.kind === 'system' && m.text.includes('[setup] completed all steps')),
    ).toBe(false);
    expect(
      msgs.some((m) => m.kind === 'system' && m.text.includes('failed with exit code 1')),
    ).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it('refuses a roster where a reviewer could write', async () => {
    const dir = repo();
    await expect(
      RoomEngine.create(
        { task: 'x', cwd: dir, agents: ['echo', 'echo'], reviewerPermission: 'edits' },
        engineOptions(),
      ),
    ).rejects.toThrow(/reviewers must be read-only/);
  });

  it('refuses a room with no reviewer, and one on an unknown runtime', async () => {
    const dir = repo();
    await expect(
      RoomEngine.create({ task: 'x', cwd: dir, agents: ['echo'] }, engineOptions()),
    ).rejects.toThrow(/at least one reviewer/);
    await expect(
      RoomEngine.create({ task: 'x', cwd: dir, agents: ['echo', 'nope'] }, engineOptions()),
    ).rejects.toThrow(/unknown runtime "nope"/);
  });

  it('runs in the checkout when the room opts out of a worktree', async () => {
    const dir = repo();
    script([workerTurn(1, 'Done.', { 'math.js': FIXED }), reviewTurn(1, verdict('approve'))]);

    const engine = await RoomEngine.create(
      { task: 'fix add()', cwd: dir, agents: ['echo', 'echo'], worktree: false },
      engineOptions(),
    );
    expect(engine.room.worktreePath).toBeNull();

    const outcome = await engine.run();
    expect(outcome.state).toBe('approved');
    expect(readFileSync(join(dir, 'math.js'), 'utf8')).toBe(FIXED);
  });

  it('without a worktree, refuses to start on a dirty tree unless told to', async () => {
    const dir = repo();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'math.js'), '// someone was mid-edit\n');

    await expect(
      RoomEngine.create(
        { task: 'x', cwd: dir, agents: ['echo', 'echo'], worktree: false },
        engineOptions(),
      ),
    ).rejects.toThrow(/uncommitted changes/);

    const engine = await RoomEngine.create(
      { task: 'x', cwd: dir, agents: ['echo', 'echo'], worktree: false, allowDirty: true },
      engineOptions(),
    );
    expect(engine.room.repoRoot).toContain(basename(dir));
  });

  it('a worktree room starts clean no matter what the checkout looks like', async () => {
    const dir = repo();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'scratch.txt'), 'someone was mid-edit\n');
    script([workerTurn(1, 'Done.', { 'math.js': FIXED }), reviewTurn(1, verdict('approve'))]);

    const engine = await open(dir);
    const outcome = await engine.run();
    expect(outcome.state).toBe('approved');
    // The human's scratch file is not in the room's diff, because it is not in the worktree.
    expect(outcome.changedFiles).toEqual(['math.js']);
  });
});

describe('RoomEngine restart recovery', () => {
  it('marks the turn that died with the process and re-runs its round to completion', async () => {
    const dir = repo();
    script([
      workerTurn(1, 'First pass.', { 'math.js': HALF }),
      reviewTurn(1, verdict('question', ['math.js:2 is the stray comment meant to stay?'])),
      workerTurn(2, 'Dropped the comment.', { 'math.js': FIXED }),
      reviewTurn(2, verdict('approve')),
    ]);

    // Round 1 really runs, and stops for the human with a question.
    const first = await open(dir);
    const roomId = first.room.id;
    expect((await first.run()).state).toBe('needs-you');
    const workerId = store.listParticipants(roomId).find((p) => p.role === 'worker')!.id;
    const sessionAfterRound1 = store.getParticipant(workerId)!.sessionId;
    expect(sessionAfterRound1).toBeTruthy();

    // Now the durable state a SIGKILLed `acr` leaves behind half way through round 2: the
    // turn row is written before the child is spawned, so it is there with no `ended_at`,
    // and the room still claims to be running. There is no way to reattach to that child.
    store.updateRoom(roomId, { round: 2, state: 'running' });
    const orphan = store.startTurn({
      roomId,
      participantId: workerId,
      round: 2,
      role: 'worker',
      permission: 'edits',
    });
    expect(orphan.endedAt).toBeNull();

    // A new process picks the room up.
    const second = await RoomEngine.load(roomId.slice(0, 8), {
      store,
      adapters: { echo: spyEcho },
      timeoutMs: 5000,
    });

    const marked = store.getTurn(orphan.id)!;
    expect(marked.endedAt).not.toBeNull();
    expect(marked.ok).toBe(false);
    expect(marked.error).toBe('interrupted by process exit');
    expect(second.room.state).toBe('idle');
    expect(second.room.round).toBe(1);
    expect(store.listMessages(roomId).some((m) => m.text.includes('round 2 was interrupted'))).toBe(
      true,
    );

    const outcome = await second.run();
    expect(outcome.state).toBe('approved');
    expect(outcome.round).toBe(2);
    expect(readFileSync(join(second.room.worktreePath!, 'math.js'), 'utf8')).toBe(FIXED);

    // The agent still remembers the room: only the turn was repeated, not the session.
    const round2Worker = requests.find(
      (r) => r.prompt.includes('(round 2)') && r.prompt.includes('as WORKER'),
    )!;
    expect(round2Worker.sessionId).toBe(sessionAfterRound1);
    expect(store.unfinishedTurns(roomId)).toHaveLength(0);
  });

  it('re-attaches to the room worktree, recreating it if it was deleted', async () => {
    const dir = repo();
    script([workerTurn(1, 'Done.', { 'math.js': FIXED }), reviewTurn(1, verdict('approve'))]);

    const first = await open(dir);
    const roomId = first.room.id;
    const worktree = first.room.worktreePath!;
    rmSync(worktree, { recursive: true, force: true });

    const second = await RoomEngine.load(roomId, { store, adapters: { echo: spyEcho } });
    expect(readFileSync(join(second.room.worktreePath!, 'math.js'), 'utf8')).toBe(BROKEN);
    expect((await second.run()).state).toBe('approved');
  });

  it('closes a room by removing its worktree and keeping the branch', async () => {
    const dir = repo();
    script([workerTurn(1, 'Done.', { 'math.js': FIXED }), reviewTurn(1, verdict('approve'))]);

    const engine = await open(dir);
    await engine.run();
    const worktree = engine.room.worktreePath!;
    const branch = engine.room.roomBranch;

    await engine.close();
    expect(store.getRoom(engine.room.id)!.closedAt).not.toBeNull();
    expect(gitIn(dir, 'branch', '--list', branch)).toContain(branch);
    expect(gitIn(dir, 'worktree', 'list')).not.toContain(worktree);
  });
});

describe('RoomEngine interactivity, the part the browser needs', () => {
  /** A room whose reviewer has a distinct runtime id, so `@echo2` names one participant. */
  function openMixed(): Promise<RoomEngine> {
    const dir = repo();
    return RoomEngine.create(
      {
        task: 'math.js exports add() but the body subtracts. Fix it.',
        cwd: dir,
        agents: ['echo', 'echo2'],
      },
      engineOptions(),
    );
  }

  it('lets a round finish, then holds instead of starting the next one', async () => {
    const dir = repo();
    script([
      workerTurn(1, 'First pass.', { 'math.js': HALF }),
      reviewTurn(1, verdict('request-changes', ['math.js:2 drop the stray comment'])),
      workerTurn(2, 'Dropped the comment.', { 'math.js': FIXED }),
      reviewTurn(2, verdict('approve')),
    ]);

    const engine = await open(dir);
    const events: EngineEvent[] = [];
    // Pause the moment the worker starts speaking – the hardest moment to get right.
    let pauseOnce = true;
    engine.subscribe((e) => {
      events.push(e);
      if (e.type === 'message.start' && pauseOnce) {
        pauseOnce = false;
        engine.pause('paused by you');
      }
    });

    const held = await engine.run();
    expect(held.paused).toBe(true);
    expect(held.state).toBe('idle');
    expect(held.round).toBe(1);
    // Round 1 finished: killing a running worker would throw away the diff it is writing.
    expect(store.listTurns(engine.room.id)).toHaveLength(2);
    expect(store.getRoom(engine.room.id)!.paused).toBe(true);
    expect(events.some((e) => e.type === 'room.paused' && e.paused)).toBe(true);
    expect(store.listMessages(engine.room.id).some((m) => m.text === 'paused by you')).toBe(true);

    // Running a still-paused room is a no-op rather than a surprise round 2.
    expect((await engine.run()).round).toBe(1);
    expect(store.listTurns(engine.room.id)).toHaveLength(2);

    // Continue picks the loop up where it stopped.
    engine.resume();
    expect(engine.room.paused).toBe(false);
    const outcome = await engine.run();
    expect(outcome.state).toBe('approved');
    expect(outcome.round).toBe(2);
    expect(outcome.paused).toBe(false);
  });

  it('carries a message you posted mid-room into the next turn"s prompt', async () => {
    const dir = repo();
    script([workerTurn(1, 'Done.', { 'math.js': FIXED }), reviewTurn(1, verdict('approve'))]);

    const engine = await open(dir);
    const posted = engine.postUserMessage('Use a named constant for the timeout, please.');
    expect(posted.kind).toBe('user');
    expect(posted.author).toBe('you');
    expect(posted.role).toBe('owner');

    // Interrupting holds the loop and points the next turn at the worker by default.
    expect(engine.room.paused).toBe(true);
    expect(engine.room.nextSpeaker).toBe('echo');

    engine.resume();
    await engine.run();

    const workerPrompt = requests.find((r) => r.prompt.includes('as WORKER'))!.prompt;
    expect(workerPrompt).toContain('Use a named constant for the timeout, please.');
    expect(workerPrompt).toContain('## New messages since your last turn');
  });

  it('routes the next turn to whoever you @mention, and refuses a name nobody has', async () => {
    const engine = await openMixed();
    expect(() => engine.postUserMessage('hi', { mention: 'gemini' })).toThrow(
      /nobody called "gemini"/,
    );
    engine.postUserMessage('What do you make of this?', { mention: 'echo2' });
    expect(engine.room.nextSpeaker).toBe('echo2');
  });

  it('runs exactly one turn for a direct mention and comes back to rest', async () => {
    script([
      {
        when: { runtime: 'echo2', role: 'reviewer', round: 1 },
        text: `Nothing to review yet.\n\n${verdict('question')}`,
      },
    ]);

    const engine = await openMixed();
    engine.postUserMessage('What do you make of this?', { mention: 'echo2' });
    engine.resume();

    const outcome = await engine.run({ directTurn: 'echo2' });

    // One turn, by the participant that was named, and nobody else spoke.
    const turns = store.listTurns(engine.room.id);
    expect(turns).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).toContain('You are echo2 acting as REVIEWER');
    // A read-only turn never takes the write lock and never captures a diff.
    expect(requests[0]!.permission).toBe('read-only');

    const spoken = store.listMessages(engine.room.id).filter((m) => m.kind === 'agent');
    expect(spoken.map((m) => m.author)).toEqual(['echo2']);
    expect(spoken[0]!.verdict?.decision).toBe('question');
    expect(spoken[0]!.diff).toBeNull();

    // A side conversation does not consume a round, and the room is left resumable.
    expect(outcome.state).toBe('idle');
    expect(outcome.round).toBe(1);
    expect(engine.room.nextSpeaker).toBeNull();
  });

  it('captures a diff when the direct turn is the worker, and refuses an unknown name', async () => {
    script([
      {
        when: { runtime: 'echo', role: 'worker' },
        text: 'Fixed it.',
        writeFiles: { 'math.js': FIXED },
      },
    ]);

    const engine = await openMixed();
    const outcome = await engine.run({ directTurn: 'echo' });

    expect(outcome.state).toBe('idle');
    expect(outcome.changedFiles).toEqual(['math.js']);
    const message = store.listMessages(engine.room.id).find((m) => m.author === 'echo')!;
    expect(message.diff).toContain('math.js');
    expect(readFileSync(join(engine.room.worktreePath!, 'math.js'), 'utf8')).toBe(FIXED);

    await expect(engine.run({ directTurn: 'gemini' })).rejects.toThrow(/nobody called "gemini"/);
  });
});
