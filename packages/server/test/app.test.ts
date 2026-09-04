import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Message, Room } from '@agent-chat-room/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FolderPicker, PickResult } from '../src/picker.js';
import { PickerUnavailableError } from '../src/picker.js';
import { ConflictError } from '../src/supervisor.js';

import {
  type Harness,
  harness,
  makeRepo,
  useTempConfigDir,
  verdict,
  waitFor,
  writeEchoScript,
} from './helpers.js';

/** A folder dialog that answers instantly with whatever the test decided. */
function fakePicker(answer: PickResult | Error): FolderPicker {
  return {
    available: () => ({ available: true, tool: 'osascript' }),
    pick: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
  };
}

const BROKEN = 'export function add(a, b) {\n  return a - b;\n}\n';
const FIXED = 'export function add(a, b) {\n  return a + b;\n}\n';

let config: ReturnType<typeof useTempConfigDir>;
let h: Harness;
const repos: string[] = [];

function repo(): string {
  const dir = makeRepo({ 'math.js': BROKEN });
  repos.push(dir);
  return dir;
}

async function createRoom(over: Record<string, unknown> = {}): Promise<{
  status: number;
  body: { room: Room; participants: { runtime: string; role: string }[]; error?: string };
}> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/rooms',
    payload: { task: 'fix add()', cwd: repo(), agents: ['echo', 'echo2'], ...over },
  });
  return { status: response.statusCode, body: response.json() };
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

describe('the REST surface', () => {
  it('reports health and the runtimes, in the same shape as `acr doctor --json`', async () => {
    const health = await h.app.inject({ url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });

    const runtimes = await h.app.inject({ url: '/api/runtimes' });
    expect(runtimes.statusCode).toBe(200);
    const payload = runtimes.json<{
      node: string;
      runtimes: { id: string }[];
      gh: { installed: boolean };
    }>();
    expect(payload.node).toBe(process.version);
    expect(payload.runtimes.map((r) => r.id)).toContain('claude');
    expect(payload.runtimes.map((r) => r.id)).toContain('cursor');
    // `gh` rides along so the browser can disable "Open PR" with a reason.
    expect(typeof payload.gh.installed).toBe('boolean');
    for (const entry of payload.runtimes) {
      expect(entry).toHaveProperty('displayName');
      expect(entry).toHaveProperty('usable');
      expect(entry).toHaveProperty('installed');
    }
  });

  it('serves a model catalog per runtime, filtered on request', async () => {
    // `?runtime=` on purpose: unfiltered, this route may spawn `cursor-agent --list-models`,
    // and no test is allowed to depend on a network round trip.
    const one = await h.app.inject({ url: '/api/runtimes/models?runtime=claude' });
    expect(one.statusCode).toBe(200);
    const { catalogs } = one.json<{
      catalogs: { runtime: string; models: { id: string }[]; source: string }[];
    }>();
    expect(catalogs).toHaveLength(1);
    expect(catalogs[0]?.runtime).toBe('claude');
    expect(catalogs[0]?.source).toBe('static');
    expect(catalogs[0]?.models.map((m) => m.id)).toContain('opus');
  });

  it('answers with an empty catalog for a runtime it has never heard of', async () => {
    const response = await h.app.inject({ url: '/api/runtimes/models?runtime=nope' });
    expect(response.statusCode).toBe(200);
    const { catalogs } = response.json<{ catalogs: { runtime: string; models: unknown[] }[] }>();
    expect(catalogs).toEqual([
      { runtime: 'nope', models: [], source: 'static', note: 'unknown runtime' },
    ]);
  });

  it('opens a brainstorm room, with a moderator last and nobody able to write', async () => {
    const created = await createRoom({ mode: 'brainstorm', agents: ['echo', 'echo2', 'echo3'] });
    expect(created.status).toBe(201);
    expect(created.body.room.mode).toBe('brainstorm');
    expect(created.body.participants.map((p) => p.role)).toEqual([
      'reviewer',
      'reviewer',
      'moderator',
    ]);
  });

  it('accepts a per-runtime model map on the create body', async () => {
    const created = await createRoom({ models: { echo: 'opus', echo2: 'gpt-5.3-codex' } });
    expect(created.status).toBe(201);
    const models = await h.app.inject({ url: `/api/rooms/${created.body.room.id}` });
    expect(
      models.json<{ participants: { runtime: string; model: string | null }[] }>().participants,
    ).toEqual([
      expect.objectContaining({ runtime: 'echo', model: 'opus' }),
      expect.objectContaining({ runtime: 'echo2', model: 'gpt-5.3-codex' }),
    ]);
  });

  it('creates a room, lists it, and reads it back with its roster and transcript', async () => {
    const created = await createRoom({ title: 'Fix add()', maxRounds: 2 });
    expect(created.status).toBe(201);
    expect(created.body.room.title).toBe('Fix add()');
    expect(created.body.room.maxRounds).toBe(2);
    expect(created.body.participants.map((p) => `${p.role}:${p.runtime}`)).toEqual([
      'worker:echo',
      'reviewer:echo2',
    ]);

    const list = await h.app.inject({ url: '/api/rooms' });
    expect(list.json<Room[]>().map((r) => r.id)).toEqual([created.body.room.id]);

    const show = await h.app.inject({ url: `/api/rooms/${created.body.room.id}` });
    expect(show.statusCode).toBe(200);
    const detail = show.json<{ messages: Message[]; live: unknown[]; running: boolean }>();
    // The task is the room's first message, exactly as in the terminal.
    expect(detail.messages.map((m) => m.kind)).toEqual(['user']);
    expect(detail.live).toEqual([]);
    expect(detail.running).toBe(false);

    // The default mode is unchanged, so an M2 client that never sends one still works.
    expect(created.body.room.mode).toBe('build-review');

    // An id prefix resolves the same way `acr rooms show 3f2a` does.
    const byPrefix = await h.app.inject({
      url: `/api/rooms/${created.body.room.id.slice(0, 8)}`,
    });
    expect(byPrefix.statusCode).toBe(200);
  });

  it('404s an unknown room and 400s a body zod rejects', async () => {
    const missing = await h.app.inject({ url: '/api/rooms/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: string }>().error).toContain('no room matches');

    const noTask = await createRoom({ task: '' });
    expect(noTask.status).toBe(400);
    expect(noTask.body.error).toContain('a room needs a task');

    const oneAgent = await createRoom({ agents: ['echo'] });
    expect(oneAgent.status).toBe(400);
    expect(oneAgent.body.error).toContain('at least one reviewer');

    // An `EngineError` is the human's problem, not a 500.
    const notARepo = await createRoom({ cwd: config.dir });
    expect(notARepo.status).toBe(400);
    expect(notARepo.body.error).toContain('not inside a git repository');
  });

  it('runs a room to approval and refuses a second start while one is in flight', async () => {
    writeEchoScript([
      { when: { role: 'worker', round: 1 }, text: 'Fixed.', writeFiles: { 'math.js': FIXED } },
      { when: { role: 'reviewer', round: 1 }, text: verdict('approve'), delayMs: 50 },
    ]);
    const { body } = await createRoom();
    const id = body.room.id;

    const started = await h.app.inject({ method: 'POST', url: `/api/rooms/${id}/start` });
    expect(started.statusCode).toBe(200);

    // The loop runs in the background: the response comes back before the round does.
    const again = await h.app.inject({ method: 'POST', url: `/api/rooms/${id}/start` });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: string }>().error).toContain('already running');

    await waitFor(() => h.store.getRoom(id)?.state === 'approved', 'approval');
    expect(h.supervisor.isRunning(id)).toBe(false);

    // The diff is taken against the sha the room opened at, so an approved-and-committed
    // round still lists what it changed – which is what the right panel renders.
    const files = await h.app.inject({ url: `/api/rooms/${id}/files` });
    const changes = files.json<{ changed: string[]; stat: string }>();
    expect(changes.changed).toEqual(['math.js']);
    expect(changes.stat).toContain('math.js');
  });

  it('serves a message diff, inline or spilled, and refuses one from another room', async () => {
    const { body } = await createRoom();
    const id = body.room.id;

    const inline = h.store.addMessage({
      roomId: id,
      author: 'echo',
      kind: 'agent',
      text: 'done',
      diff: 'diff --git a/math.js b/math.js\n',
    });
    const inlineResponse = await h.app.inject({
      url: `/api/rooms/${id}/diff?message=${inline.id}`,
    });
    expect(inlineResponse.statusCode).toBe(200);
    expect(inlineResponse.headers['content-type']).toContain('text/plain');
    expect(inlineResponse.body).toContain('diff --git');

    // A diff too big for a row lives in a file; the route has to follow it.
    const big = `${'x'.repeat(1024 * 1024 + 10)}\n`;
    const spilled = h.store.addMessage({
      roomId: id,
      author: 'echo',
      kind: 'agent',
      text: 'done',
      diff: big,
    });
    expect(h.store.getMessage(spilled.id)!.diff).toBeNull();
    expect(h.store.getMessage(spilled.id)!.diffPath).toBeTruthy();
    const spilledResponse = await h.app.inject({
      url: `/api/rooms/${id}/diff?message=${spilled.id}`,
    });
    expect(spilledResponse.body).toBe(big);

    const other = await createRoom();
    const crossRoom = await h.app.inject({
      url: `/api/rooms/${other.body.room.id}/diff?message=${inline.id}`,
    });
    expect(crossRoom.statusCode).toBe(404);
  });

  it('posts a message, which holds the loop and points at the mention', async () => {
    const { body } = await createRoom();
    const id = body.room.id;

    const posted = await h.app.inject({
      method: 'POST',
      url: `/api/rooms/${id}/messages`,
      payload: { text: 'Use a named constant.', mention: 'echo2' },
    });
    expect(posted.statusCode).toBe(201);
    const { message, room } = posted.json<{ message: Message; room: Room }>();
    expect(message.author).toBe('you');
    expect(room.paused).toBe(true);
    expect(room.nextSpeaker).toBe('echo2');

    const badMention = await h.app.inject({
      method: 'POST',
      url: `/api/rooms/${id}/messages`,
      payload: { text: 'hi', mention: 'gemini' },
    });
    expect(badMention.statusCode).toBe(400);
    expect(badMention.json<{ error: string }>().error).toContain('nobody called "gemini"');

    const empty = await h.app.inject({
      method: 'POST',
      url: `/api/rooms/${id}/messages`,
      payload: { text: '' },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('pauses, resumes, raises the round limit and closes', async () => {
    const { body } = await createRoom({ maxRounds: 1 });
    const id = body.room.id;

    const paused = await h.app.inject({ method: 'POST', url: `/api/rooms/${id}/pause` });
    expect(paused.json<{ room: Room }>().room.paused).toBe(true);

    const resumed = await h.app.inject({ method: 'POST', url: `/api/rooms/${id}/resume` });
    expect(resumed.json<{ room: Room }>().room.paused).toBe(false);

    // Raising the limit is the one edit M2 needs: a room that used up its rounds would
    // otherwise dead-end in the browser.
    const patched = await h.app.inject({
      method: 'PATCH',
      url: `/api/rooms/${id}`,
      payload: { maxRounds: 6 },
    });
    expect(patched.json<{ room: Room }>().room.maxRounds).toBe(6);
    expect((await h.supervisor.open(id)).room.maxRounds).toBe(6);

    const nothing = await h.app.inject({
      method: 'PATCH',
      url: `/api/rooms/${id}`,
      payload: {},
    });
    expect(nothing.statusCode).toBe(400);

    const closed = await h.app.inject({ method: 'POST', url: `/api/rooms/${id}/close` });
    expect(closed.json<{ room: Room }>().room.closedAt).toBeTruthy();
    // Closing forgets the engine, so a later request loads a fresh one rather than a dead one.
    expect(h.supervisor.isRunning(id)).toBe(false);
  });

  it('lists recent repos and browses the filesystem for the picker', async () => {
    const dir = repo();
    // `repoRoot` is git's answer, which on macOS resolves the /var -> /private/var symlink
    // the temp dir lives behind. The store records that, so that is what to compare against.
    const created = await createRoom({ cwd: dir });
    const root = created.body.room.repoRoot;

    const recent = await h.app.inject({ url: '/api/repos' });
    expect(recent.json<{ path: string }[]>().map((r) => r.path)).toContain(root);

    const parentOf = root.slice(0, root.lastIndexOf('/'));
    const browse = await h.app.inject({
      url: `/api/repos/browse?path=${encodeURIComponent(parentOf)}`,
    });
    expect(browse.statusCode).toBe(200);
    const listing = browse.json<{
      path: string;
      parent: string;
      entries: { name: string; isRepo: boolean }[];
    }>();
    expect(listing.path).toBe(parentOf);
    expect(listing.parent).toBeTruthy();
    // The picker's whole job: say which of these directories is a repo.
    const self = listing.entries.find((e) => e.name === root.slice(root.lastIndexOf('/') + 1));
    expect(self?.isRepo).toBe(true);

    const nowhere = await h.app.inject({
      url: `/api/repos/browse?path=${encodeURIComponent(`${root}/not-there`)}`,
    });
    expect(nowhere.statusCode).toBe(404);
  });

  it('opens a native folder dialog and says whether the pick is a repo', async () => {
    const dir = repo();
    const created = await createRoom({ cwd: dir });
    const root = created.body.room.repoRoot;

    const picked = await harness({ picker: fakePicker({ path: root }) });
    try {
      const status = await picked.app.inject({ url: '/api/repos/picker' });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({ available: true, tool: 'osascript' });

      const pick = await picked.app.inject({ method: 'POST', url: '/api/repos/pick' });
      expect(pick.statusCode).toBe(200);
      expect(pick.json()).toEqual({ path: root, repoRoot: root });

      // A page in another tab must not be able to pop a dialog on the desktop.
      const foreign = await picked.app.inject({
        method: 'POST',
        url: '/api/repos/pick',
        headers: { origin: 'https://evil.example' },
      });
      expect(foreign.statusCode).toBe(403);
    } finally {
      await picked.close();
    }

    // A directory that is not in a repo is a legitimate pick the dialog can warn about.
    const plain = mkdtempSync(join(tmpdir(), 'acr-srv-plain-'));
    repos.push(plain);
    const outside = await harness({ picker: fakePicker({ path: plain }) });
    try {
      const pick = await outside.app.inject({ method: 'POST', url: '/api/repos/pick' });
      expect(pick.json()).toMatchObject({ repoRoot: null });
    } finally {
      await outside.close();
    }
  });

  it('passes a dismissed dialog through, and explains the ways it can fail', async () => {
    const cancelled = await harness({ picker: fakePicker({ cancelled: true }) });
    try {
      const pick = await cancelled.app.inject({ method: 'POST', url: '/api/repos/pick' });
      expect(pick.statusCode).toBe(200);
      expect(pick.json()).toEqual({ cancelled: true });
    } finally {
      await cancelled.close();
    }

    const busy = await harness({ picker: fakePicker(new ConflictError('already open')) });
    try {
      const pick = await busy.app.inject({ method: 'POST', url: '/api/repos/pick' });
      expect(pick.statusCode).toBe(409);
    } finally {
      await busy.close();
    }

    const headless = await harness({
      picker: fakePicker(new PickerUnavailableError('no native folder picker')),
    });
    try {
      const pick = await headless.app.inject({ method: 'POST', url: '/api/repos/pick' });
      expect(pick.statusCode).toBe(501);
    } finally {
      await headless.close();
    }

    const gone = await harness({ picker: fakePicker({ path: '/definitely/not/here' }) });
    try {
      const pick = await gone.app.inject({ method: 'POST', url: '/api/repos/pick' });
      expect(pick.statusCode).toBe(404);
    } finally {
      await gone.close();
    }
  });

  it('returns the tail of the transcript rather than all of it', async () => {
    const { body } = await createRoom();
    const id = body.room.id;
    for (let i = 0; i < 5; i += 1) {
      h.store.addMessage({ roomId: id, author: 'system', kind: 'system', text: `line ${i}` });
    }

    const tail = await h.app.inject({ url: `/api/rooms/${id}/messages?limit=2` });
    expect(tail.json<Message[]>().map((m) => m.text)).toEqual(['line 3', 'line 4']);

    const all = (await h.app.inject({ url: `/api/rooms/${id}/messages` })).json<Message[]>();
    const after = await h.app.inject({ url: `/api/rooms/${id}/messages?afterSeq=${all[2]!.seq}` });
    expect(after.json<Message[]>().map((m) => m.text)).toEqual(['line 2', 'line 3', 'line 4']);
  });
});
