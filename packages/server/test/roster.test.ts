import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Participant, Room } from '@agent-chat-room/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Harness } from './helpers.js';
import {
  harness,
  makeRepo,
  useTempConfigDir,
  verdict,
  waitFor,
  writeEchoScript,
} from './helpers.js';

const BROKEN = 'export function add(a, b) {\n  return a - b;\n}\n';

let config: ReturnType<typeof useTempConfigDir>;
let h: Harness;
const repos: string[] = [];

function repo(files: Record<string, string> = { 'math.js': BROKEN }): string {
  const dir = makeRepo(files);
  repos.push(dir);
  return dir;
}

async function createRoom(over: Record<string, unknown> = {}): Promise<Room> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/rooms',
    payload: { task: 'fix add()', cwd: repo(), agents: ['echo', 'echo2'], ...over },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ room: Room }>().room;
}

beforeEach(async () => {
  config = useTempConfigDir();
  process.env.ACR_NO_TURN_LOG = '1';
  h = await harness();
});

afterEach(async () => {
  await h.close();
  delete process.env.ACR_ECHO_SCRIPT;
  delete process.env.ACR_NO_TURN_LOG;
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  config.restore();
});

describe('POST /api/rooms with a model the runtime never reported', () => {
  it('still opens the room, and says the name looks wrong', async () => {
    // The reported bug: `opus-5` is plausible and does not exist, and the only sign of it
    // used to be a dead first turn. Warned about, never rejected – the catalog is a picker
    // seed, not a validator.
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: {
        task: 'fix add()',
        cwd: repo(),
        agents: ['echo', 'echo2'],
        models: { claude: 'opus-5' },
      },
    });
    expect(response.statusCode).toBe(201);
    const { warnings } = response.json<{ warnings: string[] }>();
    expect(warnings.some((w) => w.includes('opus-5'))).toBe(true);
  });

  it('says nothing about a model the runtime does report', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: {
        task: 'fix add()',
        cwd: repo(),
        agents: ['echo', 'echo2'],
        models: { claude: 'opus' },
      },
    });
    expect(response.statusCode).toBe(201);
    const { warnings } = response.json<{ warnings: string[] }>();
    expect(warnings.some((w) => w.includes('opus'))).toBe(false);
  });

  it('stays quiet for a runtime with no catalog to check against', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: {
        task: 'fix add()',
        cwd: repo(),
        agents: ['echo', 'echo2'],
        models: { echo: 'whatever' },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ warnings: string[] }>().warnings).toEqual([]);
  });
});

describe('PATCH /api/rooms/:id/participants/:participantId', () => {
  it('swaps the roles and reaches the live engine, not a fresh copy of the row', async () => {
    const room = await createRoom();
    // Force the engine into the supervisor's map, which is the object a later turn uses.
    const live = await h.supervisor.open(room.id);

    const response = await h.app.inject({
      method: 'PATCH',
      url: `/api/rooms/${room.id}/participants/echo2`,
      payload: { role: 'worker' },
    });

    expect(response.statusCode).toBe(200);
    const { participants } = response.json<{ participants: Participant[] }>();
    expect(participants.map((p) => `${p.runtime}:${p.role}`)).toEqual([
      'echo:reviewer',
      'echo2:worker',
    ]);
    // The same engine object sees it – this is the stale-row bug class that `patch()`
    // exists to prevent, applied to the roster.
    expect(live.participants.find((p) => p.role === 'worker')?.runtime).toBe('echo2');
  });

  it('sets a model, and clears it with an empty string', async () => {
    const room = await createRoom();

    const set = await h.app.inject({
      method: 'PATCH',
      url: `/api/rooms/${room.id}/participants/echo`,
      payload: { model: 'opus' },
    });
    expect(set.json<{ participants: Participant[] }>().participants[0]?.model).toBe('opus');

    const cleared = await h.app.inject({
      method: 'PATCH',
      url: `/api/rooms/${room.id}/participants/echo`,
      payload: { model: '  ' },
    });
    expect(cleared.json<{ participants: Participant[] }>().participants[0]?.model).toBeNull();
  });

  it('is a 404 for a runtime that is not in the room, and a 400 for an empty patch', async () => {
    const room = await createRoom();

    const missing = await h.app.inject({
      method: 'PATCH',
      url: `/api/rooms/${room.id}/participants/cursor`,
      payload: { role: 'worker' },
    });
    expect(missing.statusCode).toBe(404);

    const empty = await h.app.inject({
      method: 'PATCH',
      url: `/api/rooms/${room.id}/participants/echo`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });

  it('is a 400 when the swap would break the single-writer rule', async () => {
    const room = await createRoom();
    const response = await h.app.inject({
      method: 'PATCH',
      url: `/api/rooms/${room.id}/participants/echo`,
      payload: { role: 'reviewer' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain('exactly one worker');
  });

  it('is a 409 while the room is running', async () => {
    writeEchoScript([
      { when: { role: 'worker', round: 1 }, text: 'working', delayMs: 500 },
      { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
    ]);
    const room = await createRoom({ start: true });
    await waitFor(() => h.supervisor.isRunning(room.id), 'the loop to start');

    const response = await h.app.inject({
      method: 'PATCH',
      url: `/api/rooms/${room.id}/participants/echo2`,
      payload: { role: 'worker' },
    });
    expect(response.statusCode).toBe(409);

    await h.supervisor.stop(room.id);
    await waitFor(() => !h.supervisor.isRunning(room.id), 'the loop to stop');
  });
});

describe('GET /api/rooms/:id/export.md', () => {
  it('serves the room as markdown, as a download', async () => {
    const room = await createRoom();
    const response = await h.app.inject({ url: `/api/rooms/${room.id}/export.md` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toContain('.md"');
    expect(response.body).toContain('# fix add()');
    expect(response.body).toContain('## Transcript');
  });
});

describe('POST /api/rooms/:id/commit', () => {
  it('commits the working tree and reports the sha', async () => {
    const room = await createRoom();
    // Stand in for a round the human wants to keep: edit the room's worktree directly.
    execFileSync('sh', ['-c', `echo 'export const add = (a, b) => a + b;' > math.js`], {
      cwd: room.worktreePath!,
    });

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/commit`,
      payload: { message: 'acr: fix add' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ sha?: string }>().sha).toBeTruthy();
    const log = execFileSync('git', ['log', '-1', '--pretty=%s'], {
      cwd: room.worktreePath!,
      encoding: 'utf8',
    });
    expect(log.trim()).toBe('acr: fix add');
  });

  it('is a 400 when there is nothing to commit', async () => {
    const room = await createRoom();
    const response = await h.app.inject({ method: 'POST', url: `/api/rooms/${room.id}/commit` });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain('nothing to commit');
  });
});

describe('POST /api/rooms/:id/pr', () => {
  it('refuses when the repo has no remote, rather than half-pushing', async () => {
    const room = await createRoom();
    const response = await h.app.inject({ method: 'POST', url: `/api/rooms/${room.id}/pr` });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toMatch(/no git remote|not installed/);
  });

  it('pushes to a local bare remote and records the url gh printed', async () => {
    // A bare repo on disk stands in for a forge: this test never opens a socket.
    const bare = join(mkdtempSync(join(tmpdir(), 'acr-remote-')), 'origin.git');
    repos.push(dirname(bare));
    execFileSync('git', ['init', '-q', '--bare', bare]);

    const source = repo();
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: source });

    const calls: string[][] = [];
    await h.close();
    h = await harness({
      gh: (args) => {
        calls.push(args);
        return Promise.resolve({
          code: 0,
          stdout: 'https://github.com/o/r/pull/7\n',
          stderr: '',
        });
      },
    });

    const created = await h.app.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: { task: 'fix add()', cwd: source, agents: ['echo', 'echo2'] },
    });
    const room = created.json<{ room: Room }>().room;

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/pr`,
      payload: { title: 'acr: fix add()' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ url?: string }>().url).toBe('https://github.com/o/r/pull/7');
    expect(calls[0]).toEqual(
      expect.arrayContaining(['pr', 'create', '--base', 'main', '--head', room.roomBranch]),
    );
    // The url survives a reload, and both the push and the url are in the transcript.
    expect(h.store.getRoom(room.id)?.prUrl).toBe('https://github.com/o/r/pull/7');
    const systemLines = h.store
      .listMessages(room.id)
      .filter((m) => m.kind === 'system')
      .map((m) => m.text);
    expect(systemLines.some((t) => t.includes('pushing'))).toBe(true);
    expect(systemLines.some((t) => t.includes('https://github.com/o/r/pull/7'))).toBe(true);
  });
});

describe('POST /api/rooms/:id/promote', () => {
  it('turns a finished brainstorm proposal into a build-review room and starts it', async () => {
    writeEchoScript([
      { when: { round: 1 }, text: 'a' },
      { when: { round: 1 }, text: 'b' },
      { when: { round: 1 }, text: 'c' },
      { when: { round: 2 }, text: 'd' },
      { when: { round: 2 }, text: 'e' },
      { when: { round: 2 }, text: 'f' },
      { when: { round: 3 }, text: 'Proposed task: split the pricing module by tier.' },
      { when: { role: 'worker', round: 1, runtime: 'echo3' }, text: 'Building it.', delayMs: 500 },
      { when: { role: 'reviewer', round: 1, runtime: 'echo' }, text: verdict('approve') },
      { when: { role: 'reviewer', round: 1, runtime: 'echo2' }, text: verdict('approve') },
    ]);

    const extra = mkdtempSync(join(tmpdir(), 'acr-extra-'));
    repos.push(extra);
    const room = await createRoom({
      mode: 'brainstorm',
      agents: ['echo', 'echo2', 'echo3'],
      models: { echo2: 'review-model' },
      additionalDirs: [extra],
      start: true,
    });
    await waitFor(
      () => h.store.getRoom(room.id)?.state === 'needs-you',
      'the brainstorm to propose',
    );

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/promote`,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ room: Room; participants: Participant[] }>();
    expect(body.room.mode).toBe('build-review');
    expect(body.room.task).toContain('split the pricing module by tier');
    expect(body.room.repoRoot).toBe(h.store.getRoom(room.id)?.repoRoot);
    expect(body.room.additionalDirs).toEqual(h.store.getRoom(room.id)?.additionalDirs);
    // The brainstorm moderator owns the proposal and becomes the promoted build worker.
    expect(body.participants.map((participant) => participant.runtime)).toEqual([
      'echo3',
      'echo',
      'echo2',
    ]);
    expect(body.participants[0]?.role).toBe('worker');
    expect(body.participants[2]?.model).toBe('review-model');
    expect(h.supervisor.isRunning(body.room.id)).toBe(true);

    await waitFor(() => !h.supervisor.isRunning(body.room.id), 'the promoted build to finish');
  });

  it('refuses to promote a build-review room, or a brainstorm with no proposal yet', async () => {
    const build = await createRoom();
    const wrongMode = await h.app.inject({
      method: 'POST',
      url: `/api/rooms/${build.id}/promote`,
    });
    expect(wrongMode.statusCode).toBe(400);

    const fresh = await createRoom({ mode: 'brainstorm', agents: ['echo', 'echo2', 'echo3'] });
    const noProposal = await h.app.inject({
      method: 'POST',
      url: `/api/rooms/${fresh.id}/promote`,
    });
    expect(noProposal.statusCode).toBe(409);
  });
});
