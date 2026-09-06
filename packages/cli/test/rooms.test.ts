import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RoomStore, resetEchoAdapter } from '@agent-chat-room/core';

import { rooms } from '../src/commands/rooms.js';
import { run } from '../src/commands/run.js';
import { EXIT } from '../src/exit.js';
import { Renderer } from '../src/render.js';
import { Capture, gitIn, makeRepo, useTempConfigDir, writeEchoScript } from './helpers.js';

const BROKEN = 'export function add(a, b) {\n  return a - b;\n}\n';
const HALF = 'export function add(a, b) {\n  return a + b; // todo\n}\n';
const FIXED = 'export function add(a, b) {\n  return a + b;\n}\n';

const verdict = (decision: string, blocking: string[] = []): string =>
  `Review body.\n\n\`\`\`verdict\n${JSON.stringify({ decision, blocking, nits: [] })}\n\`\`\``;

const workerTurn = (round: number, text: string, files?: Record<string, string>) => ({
  when: { role: 'worker', round },
  text,
  ...(files ? { writeFiles: files } : {}),
});
const reviewTurn = (round: number, text: string) => ({ when: { role: 'reviewer', round }, text });

const repos: string[] = [];
let config: ReturnType<typeof useTempConfigDir>;
let store: RoomStore;
let stdout: string[];
let writeSpy: typeof process.stdout.write;

function repo(): string {
  const dir = makeRepo({ 'math.js': BROKEN });
  repos.push(dir);
  return dir;
}

beforeEach(() => {
  config = useTempConfigDir();
  process.env.ACR_NO_TURN_LOG = '1';
  // As in run.test.ts: the branch-naming turn would eat a scripted echo turn.
  process.env.ACR_NO_AUTO_BRANCH_NAME = '1';
  store = RoomStore.open();
  resetEchoAdapter();
  stdout = [];
  writeSpy = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string) => {
    stdout.push(String(chunk));
    return true;
  };
});

afterEach(() => {
  process.stdout.write = writeSpy;
  store.close();
  delete process.env.ACR_ECHO_SCRIPT;
  delete process.env.ACR_NO_TURN_LOG;
  delete process.env.ACR_NO_AUTO_BRANCH_NAME;
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetEchoAdapter();
  config.restore();
});

/** Run a room to completion so `rooms` has something to list. */
async function seed(dir: string, turns: unknown[]) {
  process.env.ACR_ECHO_SCRIPT = writeEchoScript({ turns });
  const summary = await run({
    task: 'fix add()',
    cwd: dir,
    agents: ['echo', 'echo'],
    timeoutMs: 5000,
    store,
    renderer: new Renderer({ color: false, write: () => undefined }),
  });
  resetEchoAdapter();
  return summary;
}

describe('acr rooms', () => {
  it('lists nothing helpfully when the store is empty', async () => {
    const capture = new Capture();
    const code = await rooms({
      subcommand: 'ls',
      cwd: process.cwd(),
      store,
      renderer: new Renderer({ color: false, write: capture.write }),
    });
    expect(code).toBe(EXIT.ok);
    expect(capture.text).toContain('no rooms yet');
  });

  it('lists a room with its state, round and branch', async () => {
    const dir = repo();
    const summary = await seed(dir, [
      workerTurn(1, 'Done.', { 'math.js': FIXED }),
      reviewTurn(1, verdict('approve')),
    ]);

    const capture = new Capture();
    await rooms({
      subcommand: 'ls',
      cwd: dir,
      store,
      renderer: new Renderer({ color: false, write: capture.write }),
    });
    expect(capture.text).toContain(summary.roomId.slice(0, 8));
    expect(capture.text).toContain('approved');
    expect(capture.text).toContain(summary.branch);
  });

  it('shows a room transcript, verdicts included', async () => {
    const dir = repo();
    const summary = await seed(dir, [
      workerTurn(1, 'Swapped the operator.', { 'math.js': FIXED }),
      reviewTurn(1, verdict('approve')),
    ]);

    const capture = new Capture();
    const code = await rooms({
      subcommand: 'show',
      id: summary.roomId.slice(0, 8),
      cwd: dir,
      store,
      renderer: new Renderer({ color: false, write: capture.write }),
    });
    expect(code).toBe(EXIT.ok);
    expect(capture.text).toContain('Swapped the operator.');
    expect(capture.text).toContain('worker');
    expect(capture.text).toContain('APPROVE');
    expect(capture.text).toContain('committed');
  });

  it('emits machine-readable JSON when asked', async () => {
    const dir = repo();
    const summary = await seed(dir, [
      workerTurn(1, 'Done.', { 'math.js': FIXED }),
      reviewTurn(1, verdict('approve')),
    ]);

    await rooms({ subcommand: 'ls', cwd: dir, json: true, store });
    const listed = JSON.parse(stdout.join('')) as { id: string }[];
    expect(listed.map((r) => r.id)).toContain(summary.roomId);

    stdout.length = 0;
    await rooms({ subcommand: 'show', id: summary.roomId, cwd: dir, json: true, store });
    const shown = JSON.parse(stdout.join('')) as {
      room: { id: string };
      participants: unknown[];
      messages: unknown[];
      turns: unknown[];
    };
    expect(shown.room.id).toBe(summary.roomId);
    expect(shown.participants).toHaveLength(2);
    expect(shown.turns).toHaveLength(2);
  });

  it('resumes a room that stopped for a question', async () => {
    const dir = repo();
    const first = await seed(dir, [
      workerTurn(1, 'Attempt.', { 'math.js': HALF }),
      reviewTurn(1, verdict('question', ['math.js:2 todo?'])),
    ]);
    expect(first.state).toBe('needs-you');

    process.env.ACR_ECHO_SCRIPT = writeEchoScript({
      turns: [workerTurn(2, 'Fixed.', { 'math.js': FIXED }), reviewTurn(2, verdict('approve'))],
    });

    const capture = new Capture();
    const code = await rooms({
      subcommand: 'resume',
      id: first.roomId.slice(0, 8),
      cwd: dir,
      store,
      timeoutMs: 5000,
      renderer: new Renderer({ color: false, write: capture.write }),
    });
    expect(code).toBe(EXIT.ok);
    expect(capture.text).toContain('---- round 2 ----');
    expect(store.getRoom(first.roomId)?.state).toBe('approved');
  });

  it('closes a room, removing the worktree and keeping the branch', async () => {
    const dir = repo();
    const summary = await seed(dir, [
      workerTurn(1, 'Done.', { 'math.js': FIXED }),
      reviewTurn(1, verdict('approve')),
    ]);
    expect(existsSync(summary.worktree!)).toBe(true);

    const capture = new Capture();
    const code = await rooms({
      subcommand: 'close',
      id: summary.roomId,
      cwd: dir,
      store,
      renderer: new Renderer({ color: false, write: capture.write }),
    });
    expect(code).toBe(EXIT.ok);
    expect(existsSync(summary.worktree!)).toBe(false);
    expect(gitIn(dir, 'branch', '--list', summary.branch)).toContain(summary.branch);
    expect(store.getRoom(summary.roomId)?.closedAt).not.toBeNull();
  });

  it('exports a room as markdown, to stdout and to --out', async () => {
    const dir = repo();
    const summary = await seed(dir, [
      workerTurn(1, 'Swapped the operator in math.js.', { 'math.js': FIXED }),
      reviewTurn(1, verdict('approve')),
    ]);

    const toStdout = await rooms({
      subcommand: 'export',
      id: summary.roomId,
      cwd: dir,
      store,
      renderer: new Renderer({ color: false, write: () => undefined }),
    });
    expect(toStdout).toBe(EXIT.ok);
    const markdown = stdout.join('');
    expect(markdown).toContain('# fix add()');
    expect(markdown).toContain('## Participants');
    expect(markdown).toContain('Swapped the operator in math.js.');
    expect(markdown).toContain('**APPROVE**');

    const out = join(mkdtempSync(join(tmpdir(), 'acr-export-')), 'room.md');
    const capture = new Capture();
    const toFile = await rooms({
      subcommand: 'export',
      id: summary.roomId,
      out,
      cwd: dir,
      store,
      renderer: new Renderer({ color: false, write: capture.write }),
    });
    expect(toFile).toBe(EXIT.ok);
    expect(readFileSync(out, 'utf8')).toBe(markdown);
    expect(capture.text).toContain(`wrote ${out}`);
    rmSync(out, { force: true });
  });

  it('rejects an unknown subcommand and a missing id', async () => {
    await expect(rooms({ subcommand: 'frobnicate', cwd: process.cwd(), store })).rejects.toThrow(
      /unknown rooms subcommand/,
    );
    await expect(rooms({ subcommand: 'show', cwd: process.cwd(), store })).rejects.toThrow(
      /needs a room id/,
    );
    await expect(
      rooms({ subcommand: 'show', id: 'nope', cwd: process.cwd(), store }),
    ).rejects.toThrow(/no room matches "nope"/);
  });

  it('refuses to purge an open room', async () => {
    const dir = repo();
    const summary = await seed(dir, [
      workerTurn(1, 'Swapped operator.', { 'math.js': FIXED }),
      reviewTurn(1, verdict('approve')),
    ]);

    const capture = new Capture();
    const code = await rooms({
      subcommand: 'purge',
      id: summary.roomId,
      cwd: dir,
      store,
      renderer: new Renderer({ color: false, write: capture.write }),
    });
    expect(code).toBe(EXIT.usage);
    expect(capture.text).toContain('is still open');
    expect(store.findRoom(summary.roomId)).toBeDefined();
  });

  it('purges a closed room from the store', async () => {
    const dir = repo();
    const summary = await seed(dir, [
      workerTurn(1, 'Swapped operator.', { 'math.js': FIXED }),
      reviewTurn(1, verdict('approve')),
    ]);

    await rooms({
      subcommand: 'close',
      id: summary.roomId,
      cwd: dir,
      store,
      renderer: new Renderer({ color: false, write: () => undefined }),
    });

    const capture = new Capture();
    const code = await rooms({
      subcommand: 'purge',
      id: summary.roomId,
      cwd: dir,
      store,
      renderer: new Renderer({ color: false, write: capture.write }),
    });
    expect(code).toBe(EXIT.ok);
    expect(capture.text).toContain('purged room');
    expect(store.findRoom(summary.roomId)).toBeUndefined();
  });
});
