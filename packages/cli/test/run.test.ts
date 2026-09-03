import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetEchoAdapter } from '@agent-chat-room/core';

import { run } from '../src/commands/run.js';
import { EXIT } from '../src/exit.js';
import { Renderer } from '../src/render.js';
import { Capture, makeRepo, writeEchoScript } from './helpers.js';

const BROKEN = 'export function add(a, b) {\n  return a - b;\n}\n';
const FIXED = 'export function add(a, b) {\n  return a + b;\n}\n';

const repos: string[] = [];

function repo(files: Record<string, string>): string {
  const dir = makeRepo(files);
  repos.push(dir);
  return dir;
}

beforeEach(() => {
  resetEchoAdapter();
});

afterEach(() => {
  delete process.env.ACR_ECHO_SCRIPT;
  delete process.env.ACR_NO_TURN_LOG;
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetEchoAdapter();
});

function scriptedRun(dir: string, turns: unknown[], task = 'fix add()') {
  process.env.ACR_ECHO_SCRIPT = writeEchoScript({ turns });
  process.env.ACR_NO_TURN_LOG = '1';
  const capture = new Capture();
  return {
    capture,
    promise: run({
      task,
      cwd: dir,
      agents: ['echo', 'echo'],
      timeoutMs: 5000,
      renderer: new Renderer({ color: false, write: capture.write }),
    }),
  };
}

describe('acr run, one worker turn then one reviewer turn', () => {
  it('carries the worker diff into the reviewer prompt and parses the verdict', async () => {
    const dir = repo({ 'math.js': BROKEN });
    const { capture, promise } = scriptedRun(dir, [
      {
        text: 'Changed the operator in math.js from - to +.',
        writeFiles: { 'math.js': FIXED },
      },
      {
        text: 'Correct.\n\n```verdict\n{"decision":"approve","blocking":[],"nits":["add a test"]}\n```',
      },
    ]);
    const summary = await promise;

    // The worker really edited the repo.
    expect(readFileSync(join(dir, 'math.js'), 'utf8')).toBe(FIXED);
    expect(summary.changedFiles).toEqual(['math.js']);

    expect(summary.verdict?.ok).toBe(true);
    expect(summary.verdict?.ok === true && summary.verdict.verdict.decision).toBe('approve');
    expect(summary.ok).toBe(true);
    expect(summary.exitCode).toBe(EXIT.ok);

    const transcript = capture.text;
    expect(transcript).toContain('[echo · worker · r1]');
    expect(transcript).toContain('[echo · reviewer · r1]');
    expect(transcript).toContain('APPROVE');
    expect(transcript).toContain('nit: add a test');
  });

  it('gives the reviewer the worker message and the actual diff', async () => {
    const dir = repo({ 'math.js': BROKEN });
    const prompts: string[] = [];
    process.env.ACR_ECHO_SCRIPT = writeEchoScript({
      turns: [
        { text: 'swapped the operator', writeFiles: { 'math.js': FIXED } },
        { text: '```verdict\n{"decision":"approve"}\n```' },
      ],
    });
    process.env.ACR_NO_TURN_LOG = '1';

    // Spy on what each turn was actually asked, by wrapping the adapter registry entry.
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

  it('exits notApproved on request-changes and lists the blocking items', async () => {
    const dir = repo({ 'math.js': BROKEN });
    const { capture, promise } = scriptedRun(dir, [
      { text: 'did something', writeFiles: { 'math.js': FIXED } },
      {
        text: 'Nope.\n\n```verdict\n{"decision":"request-changes","blocking":["math.js:2 still wrong"]}\n```',
      },
    ]);
    const summary = await promise;
    expect(summary.ok).toBe(false);
    expect(summary.exitCode).toBe(EXIT.notApproved);
    expect(capture.text).toContain('REQUEST CHANGES');
    expect(capture.text).toContain('blocking: math.js:2 still wrong');
  });

  it('refuses to approve when the reviewer forgot the verdict block, and shows the tail', async () => {
    const dir = repo({ 'math.js': BROKEN });
    const { capture, promise } = scriptedRun(dir, [
      { text: 'did something', writeFiles: { 'math.js': FIXED } },
      { text: 'Looks good to me, ship it.' },
    ]);
    const summary = await promise;
    expect(summary.exitCode).toBe(EXIT.notApproved);
    expect(summary.verdict?.ok).toBe(false);
    expect(capture.text).toContain('no verdict');
    expect(capture.text).toContain('Looks good to me, ship it.');
  });

  it('stops after a failed worker turn instead of reviewing nothing', async () => {
    const dir = repo({ 'math.js': BROKEN });
    const { capture, promise } = scriptedRun(dir, [
      { error: 'the runtime fell over' },
      { text: '```verdict\n{"decision":"approve"}\n```' },
    ]);
    const summary = await promise;
    expect(summary.exitCode).toBe(EXIT.internalError);
    expect(summary.reviewer).toBeUndefined();
    expect(capture.text).toContain('worker turn failed');
  });

  it('refuses to start on a dirty tree, because M0 has no worktree yet', async () => {
    const dir = repo({ 'math.js': BROKEN });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'math.js'), '// someone was mid-edit\n');

    await expect(
      run({
        task: 'fix add()',
        cwd: dir,
        agents: ['echo', 'echo'],
        timeoutMs: 5000,
        renderer: new Renderer({ color: false, write: () => undefined }),
      }),
    ).rejects.toThrow(/uncommitted changes/);
  });

  it('runs on a dirty tree when explicitly allowed', async () => {
    const dir = repo({ 'math.js': BROKEN });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'notes.txt'), 'scratch\n');

    process.env.ACR_ECHO_SCRIPT = writeEchoScript({
      turns: [
        { text: 'ok', writeFiles: { 'math.js': FIXED } },
        { text: '```verdict\n{"decision":"approve"}\n```' },
      ],
    });
    process.env.ACR_NO_TURN_LOG = '1';
    const summary = await run({
      task: 'fix add()',
      cwd: dir,
      agents: ['echo', 'echo'],
      timeoutMs: 5000,
      allowDirty: true,
      renderer: new Renderer({ color: false, write: () => undefined }),
    });
    expect(summary.exitCode).toBe(EXIT.ok);
    // The untracked file the human left behind is still part of the captured diff.
    expect(summary.changedFiles).toContain('notes.txt');
  });

  it('rejects an unknown runtime by name', async () => {
    const dir = repo({ 'math.js': BROKEN });
    await expect(
      run({
        task: 'x',
        cwd: dir,
        agents: ['echo', 'nope'],
        timeoutMs: 1000,
        renderer: new Renderer({ color: false, write: () => undefined }),
      }),
    ).rejects.toThrow(/unknown runtime "nope"/);
  });
});
