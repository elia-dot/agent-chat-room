import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RoomStore, resetEchoAdapter } from '@agent-chat-room/core';

import { run } from '../src/commands/run.js';
import { EXIT } from '../src/exit.js';
import { Renderer } from '../src/render.js';
import { Capture, gitIn, makeRepo, useTempConfigDir, writeEchoScript } from './helpers.js';

const BROKEN = 'export function add(a, b) {\n  return a - b;\n}\n';
const HALF = 'export function add(a, b) {\n  return a + b; // todo\n}\n';
const FIXED = 'export function add(a, b) {\n  return a + b;\n}\n';

const verdict = (decision: string, blocking: string[] = [], nits: string[] = []): string =>
  `Review body.\n\n\`\`\`verdict\n${JSON.stringify({ decision, blocking, nits })}\n\`\`\``;

const workerTurn = (round: number, text: string, files?: Record<string, string>) => ({
  when: { role: 'worker', round },
  text,
  ...(files ? { writeFiles: files } : {}),
});
const reviewTurn = (round: number, text: string) => ({ when: { role: 'reviewer', round }, text });

const repos: string[] = [];
let config: ReturnType<typeof useTempConfigDir>;
let store: RoomStore;

function repo(files: Record<string, string> = { 'math.js': BROKEN }): string {
  const dir = makeRepo(files);
  repos.push(dir);
  return dir;
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

function scriptedRun(
  dir: string,
  turns: unknown[],
  overrides: Partial<Parameters<typeof run>[0]> = {},
) {
  process.env.ACR_ECHO_SCRIPT = writeEchoScript({ turns });
  const capture = new Capture();
  return {
    capture,
    promise: run({
      task: 'fix add()',
      cwd: dir,
      agents: ['echo', 'echo'],
      timeoutMs: 5000,
      store,
      renderer: new Renderer({ color: false, write: capture.write }),
      ...overrides,
    }),
  };
}

describe('acr run, driving the room engine', () => {
  it('runs a room in its own worktree and leaves the checkout alone', async () => {
    const dir = repo();
    const { capture, promise } = scriptedRun(dir, [
      workerTurn(1, 'Changed the operator in math.js from - to +.', { 'math.js': FIXED }),
      reviewTurn(1, verdict('approve', [], ['add a test'])),
    ]);
    const summary = await promise;

    expect(summary.exitCode).toBe(EXIT.ok);
    expect(summary.ok).toBe(true);
    expect(summary.rounds).toBe(1);
    expect(summary.state).toBe('approved');
    expect(summary.changedFiles).toEqual(['math.js']);
    expect(summary.branch).toMatch(/^acr\//);
    expect(summary.commit).toBeTruthy();

    // The room edited its worktree, not the repo the human is standing in.
    expect(readFileSync(join(summary.worktree!, 'math.js'), 'utf8')).toBe(FIXED);
    expect(readFileSync(join(dir, 'math.js'), 'utf8')).toBe(BROKEN);

    const transcript = capture.text;
    expect(transcript).toContain('---- round 1 ----');
    expect(transcript).toContain('[echo · worker · r1]');
    expect(transcript).toContain('[echo · reviewer · r1]');
    expect(transcript).toContain('Changed the operator in math.js');
    expect(transcript).toContain('APPROVE');
    expect(transcript).toContain('nit: add a test');
    expect(transcript).toContain('1 of 1 approved');
    expect(transcript).toContain('APPROVED');
  });

  it('gives the reviewer the worker message and the actual diff', async () => {
    const dir = repo();
    const prompts: string[] = [];
    process.env.ACR_ECHO_SCRIPT = writeEchoScript({
      turns: [
        workerTurn(1, 'swapped the operator', { 'math.js': FIXED }),
        reviewTurn(1, verdict('approve')),
      ],
    });

    const core = await import('@agent-chat-room/core');
    const echo = core.getAdapter('echo')!;
    const originalRun = echo.run.bind(echo);
    echo.run = (req, sink) => {
      prompts.push(req.prompt);
      return originalRun(req, sink);
    };

    try {
      await run({
        task: 'fix add()',
        cwd: dir,
        agents: ['echo', 'echo'],
        timeoutMs: 5000,
        store,
        renderer: new Renderer({ color: false, write: () => undefined }),
      });
    } finally {
      echo.run = originalRun;
    }

    expect(prompts).toHaveLength(2);
    const [workerPrompt, reviewerPrompt] = prompts as [string, string];
    expect(workerPrompt).toContain('acting as WORKER');
    expect(workerPrompt).not.toContain('## Changes in this room so far');

    expect(reviewerPrompt).toContain('acting as REVIEWER');
    expect(reviewerPrompt).toContain('swapped the operator');
    expect(reviewerPrompt).toContain('## Changes in this room so far');
    expect(reviewerPrompt).toContain('-  return a - b;');
    expect(reviewerPrompt).toContain('+  return a + b;');
  });

  it('loops until the reviewer approves, and prints each round', async () => {
    const dir = repo();
    const { capture, promise } = scriptedRun(dir, [
      workerTurn(1, 'First pass.', { 'math.js': HALF }),
      reviewTurn(1, verdict('request-changes', ['math.js:2 drop the todo'])),
      workerTurn(2, 'Dropped the todo.', { 'math.js': FIXED }),
      reviewTurn(2, verdict('approve')),
    ]);
    const summary = await promise;

    expect(summary.exitCode).toBe(EXIT.ok);
    expect(summary.rounds).toBe(2);
    expect(capture.text).toContain('---- round 1 ----');
    expect(capture.text).toContain('---- round 2 ----');
    expect(capture.text).toContain('blocking: math.js:2 drop the todo');
    expect(readFileSync(join(summary.worktree!, 'math.js'), 'utf8')).toBe(FIXED);
  });

  it('takes more than two agents, with everyone after the first reviewing', async () => {
    const dir = repo();
    const { promise } = scriptedRun(
      dir,
      [
        workerTurn(1, 'Done.', { 'math.js': FIXED }),
        reviewTurn(1, verdict('approve')),
        reviewTurn(1, verdict('approve')),
      ],
      { agents: ['echo', 'echo', 'echo'] },
    );
    const summary = await promise;
    expect(summary.exitCode).toBe(EXIT.ok);
    expect(summary.reviews).toHaveLength(2);
  });

  it('exits notApproved when the rounds run out, and does not commit', async () => {
    const dir = repo();
    const { capture, promise } = scriptedRun(
      dir,
      [
        workerTurn(1, 'Attempt.', { 'math.js': HALF }),
        reviewTurn(1, verdict('request-changes', ['math.js:2 still wrong'])),
      ],
      { maxRounds: 1 },
    );
    const summary = await promise;

    expect(summary.exitCode).toBe(EXIT.notApproved);
    expect(summary.state).toBe('needs-you');
    expect(summary.commit).toBeUndefined();
    expect(capture.text).toContain('REQUEST CHANGES');
    expect(capture.text).toContain('blocking: math.js:2 still wrong');
    expect(gitIn(summary.worktree!, 'rev-list', '--count', 'HEAD')).toBe('1');
  });

  it('refuses to approve when the reviewer forgot the verdict block, and shows the tail', async () => {
    const dir = repo();
    const { capture, promise } = scriptedRun(
      dir,
      [workerTurn(1, 'did something', { 'math.js': FIXED }), reviewTurn(1, 'Looks good, ship it.')],
      { maxRounds: 1 },
    );
    const summary = await promise;
    expect(summary.exitCode).toBe(EXIT.notApproved);
    expect(summary.verdict?.ok).toBe(false);
    expect(capture.text).toContain('did not end with a verdict block');
    expect(capture.text).toContain('Looks good, ship it.');
  });

  it('stops after a failed worker turn instead of reviewing nothing', async () => {
    const dir = repo();
    const { capture, promise } = scriptedRun(dir, [
      { when: { role: 'worker', round: 1 }, error: 'the runtime fell over' },
      reviewTurn(1, verdict('approve')),
    ]);
    const summary = await promise;
    expect(summary.exitCode).toBe(EXIT.internalError);
    expect(summary.reviews).toEqual([]);
    expect(capture.text).toContain('worker turn failed');
  });

  it('with --no-worktree it edits the checkout, and refuses a dirty tree', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'notes.txt'), 'scratch\n');

    await expect(
      run({
        task: 'fix add()',
        cwd: dir,
        agents: ['echo', 'echo'],
        worktree: false,
        timeoutMs: 5000,
        store,
        renderer: new Renderer({ color: false, write: () => undefined }),
      }),
    ).rejects.toThrow(/uncommitted changes/);

    process.env.ACR_ECHO_SCRIPT = writeEchoScript({
      turns: [workerTurn(1, 'ok', { 'math.js': FIXED }), reviewTurn(1, verdict('approve'))],
    });
    const summary = await run({
      task: 'fix add()',
      cwd: dir,
      agents: ['echo', 'echo'],
      worktree: false,
      allowDirty: true,
      timeoutMs: 5000,
      store,
      renderer: new Renderer({ color: false, write: () => undefined }),
    });
    expect(summary.exitCode).toBe(EXIT.ok);
    expect(readFileSync(join(dir, 'math.js'), 'utf8')).toBe(FIXED);
    // The untracked file the human left behind is part of the captured diff here.
    expect(summary.changedFiles).toContain('notes.txt');
  });

  it('reads its roster and round count from .acr.json', async () => {
    const dir = repo({
      'math.js': BROKEN,
      '.acr.json': JSON.stringify({ agents: ['echo', 'echo'], rounds: 1 }),
    });
    process.env.ACR_ECHO_SCRIPT = writeEchoScript({
      turns: [
        workerTurn(1, 'ok', { 'math.js': HALF }),
        reviewTurn(1, verdict('request-changes', ['math.js:2 todo'])),
      ],
    });
    const summary = await run({
      task: 'fix add()',
      cwd: dir,
      timeoutMs: 5000,
      store,
      renderer: new Renderer({ color: false, write: () => undefined }),
    });
    // `rounds: 1` from the file, so one round and then needs-you.
    expect(summary.rounds).toBe(1);
    expect(summary.exitCode).toBe(EXIT.notApproved);
  });

  it('warns about an unknown .acr.json key instead of refusing to run', async () => {
    const dir = repo({
      'math.js': BROKEN,
      '.acr.json': JSON.stringify({ agents: ['echo', 'echo'], futureThing: 1 }),
    });
    const { capture, promise } = scriptedRun(
      dir,
      [workerTurn(1, 'ok', { 'math.js': FIXED }), reviewTurn(1, verdict('approve'))],
      { agents: undefined },
    );
    const summary = await promise;
    expect(summary.exitCode).toBe(EXIT.ok);
    expect(capture.text).toContain('unknown key "futureThing"');
  });

  it('resumes an existing room by id', async () => {
    const dir = repo();
    const { promise } = scriptedRun(
      dir,
      [
        workerTurn(1, 'Attempt.', { 'math.js': HALF }),
        reviewTurn(1, verdict('request-changes', ['math.js:2 todo'])),
      ],
      { maxRounds: 1 },
    );
    const first = await promise;
    expect(first.state).toBe('needs-you');

    // A second invocation picks the room up, keeping its worktree, branch and sessions.
    store.updateRoom(first.roomId, { maxRounds: 2 });
    resetEchoAdapter();
    process.env.ACR_ECHO_SCRIPT = writeEchoScript({
      turns: [workerTurn(2, 'Fixed.', { 'math.js': FIXED }), reviewTurn(2, verdict('approve'))],
    });

    const second = await run({
      cwd: dir,
      room: first.roomId.slice(0, 8),
      timeoutMs: 5000,
      store,
      renderer: new Renderer({ color: false, write: () => undefined }),
    });
    expect(second.roomId).toBe(first.roomId);
    expect(second.exitCode).toBe(EXIT.ok);
    expect(second.rounds).toBe(2);
    expect(second.worktree).toBe(first.worktree);
  });

  it('rejects an unknown runtime by name', async () => {
    const dir = repo();
    await expect(
      run({
        task: 'x',
        cwd: dir,
        agents: ['echo', 'nope'],
        timeoutMs: 1000,
        store,
        renderer: new Renderer({ color: false, write: () => undefined }),
      }),
    ).rejects.toThrow(/unknown runtime "nope"/);
  });

  it('refuses to run outside a git repository', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'acr-notrepo-'));
    try {
      await expect(
        run({
          task: 'x',
          cwd: dir,
          agents: ['echo', 'echo'],
          timeoutMs: 1000,
          store,
          renderer: new Renderer({ color: false, write: () => undefined }),
        }),
      ).rejects.toThrow(/not inside a git repository/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
