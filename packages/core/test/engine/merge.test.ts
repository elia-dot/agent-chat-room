import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { echoAdapter, resetEchoAdapter } from '../../src/adapters/echo.js';
import type { AcquireLockOptions } from '../../src/engine/lock.js';
import { lockPathFor } from '../../src/engine/lock.js';
import { RoomEngine } from '../../src/engine/room.js';
import { locksDir, roomLockPath } from '../../src/paths.js';
import { RoomStore } from '../../src/store/rooms.js';
import { gitIn, makeRepo, useTempConfigDir, writeEchoScript } from '../helpers.js';

const BROKEN = 'export function add(a, b) {\n  return a - b;\n}\n';
const FIXED = 'export function add(a, b) {\n  return a + b;\n}\n';

const verdict = (decision: string): string =>
  `Review body.\n\n\`\`\`verdict\n${JSON.stringify({ decision, blocking: [], nits: [] })}\n\`\`\``;

let config: ReturnType<typeof useTempConfigDir>;
let store: RoomStore;
const repos: string[] = [];

function repo(): string {
  const dir = makeRepo({ 'math.js': BROKEN });
  repos.push(dir);
  return dir;
}

/** An approved room: one worker turn that fixes `math.js`, one reviewer that approves. */
async function approvedRoom(
  dir: string,
  opts: { worktree?: boolean; lock?: AcquireLockOptions } = {},
): Promise<RoomEngine> {
  process.env.ACR_ECHO_SCRIPT = writeEchoScript({
    turns: [
      {
        when: { role: 'worker', round: 1 },
        text: 'Swapped the operator.',
        writeFiles: { 'math.js': FIXED },
      },
      { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
    ],
  });
  const engine = await RoomEngine.create(
    {
      task: 'math.js exports add() but the body subtracts. Fix it.',
      cwd: dir,
      agents: ['echo', 'echo'],
      ...(opts.worktree === undefined ? {} : { worktree: opts.worktree }),
    },
    {
      store,
      adapters: { echo: echoAdapter },
      timeoutMs: 5000,
      ...(opts.lock ? { lock: opts.lock } : {}),
    },
  );
  expect((await engine.run()).state).toBe('approved');
  return engine;
}

beforeEach(() => {
  config = useTempConfigDir();
  process.env.ACR_NO_TURN_LOG = '1';
  // Otherwise the branch-naming turn eats one of the two scripted echo turns.
  process.env.ACR_NO_AUTO_BRANCH_NAME = '1';
  store = RoomStore.open();
  resetEchoAdapter();
});

afterEach(() => {
  store.close();
  delete process.env.ACR_ECHO_SCRIPT;
  delete process.env.ACR_NO_TURN_LOG;
  delete process.env.ACR_NO_AUTO_BRANCH_NAME;
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetEchoAdapter();
  config.restore();
});

describe('RoomEngine.merge', () => {
  it('lands the room branch on the base branch in the human checkout', async () => {
    const dir = repo();
    const engine = await approvedRoom(dir);
    // Until the merge, the checkout is exactly where the human left it.
    expect(readFileSync(join(dir, 'math.js'), 'utf8')).toBe(BROKEN);

    const result = await engine.merge();

    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, 'math.js'), 'utf8')).toBe(FIXED);
    expect(gitIn(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(gitIn(dir, 'log', '-1', '--pretty=%s')).toContain('acr: ');
    expect(gitIn(dir, 'log', '-1', '--pretty=%b')).toContain(engine.room.id);
    // A merge commit, so the round stays attributable to the room after the branch is gone.
    expect(gitIn(dir, 'log', '-1', '--pretty=%P').split(' ')).toHaveLength(2);
  });

  it('says so in the transcript', async () => {
    const dir = repo();
    const engine = await approvedRoom(dir);

    await engine.merge();

    const lines = store
      .listMessages(engine.room.id)
      .filter((m) => m.kind === 'system')
      .map((m) => m.text);
    expect(lines.some((t) => t.includes(`merged ${engine.room.roomBranch} into main`))).toBe(true);
  });

  it('is idempotent: a second merge reports the base branch already has it', async () => {
    const dir = repo();
    const engine = await approvedRoom(dir);
    await engine.merge();
    const head = gitIn(dir, 'rev-parse', 'HEAD');

    const again = await engine.merge();

    expect(again).toMatchObject({ ok: true, alreadyUpToDate: true });
    expect(gitIn(dir, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('refuses while the room still has uncommitted work', async () => {
    const dir = repo();
    const engine = await approvedRoom(dir);
    writeFileSync(join(engine.room.worktreePath!, 'math.js'), 'half-finished\n');

    await expect(engine.merge()).rejects.toThrow(/uncommitted work/);
    expect(readFileSync(join(dir, 'math.js'), 'utf8')).toBe(BROKEN);
  });

  it('refuses while another process is driving the room, and touches nothing', async () => {
    const dir = repo();
    const engine = await approvedRoom(dir);
    mkdirSync(locksDir(), { recursive: true });
    // Our own pid is alive, so this looks exactly like another acr holding the room.
    writeFileSync(
      roomLockPath(engine.room.id),
      JSON.stringify({ pid: process.pid, subject: `room:${engine.room.id}`, acquiredAt: 'now' }),
    );

    await expect(engine.merge()).rejects.toThrow(/Another acr process is driving this room/);
    expect(readFileSync(join(dir, 'math.js'), 'utf8')).toBe(BROKEN);

    rmSync(roomLockPath(engine.room.id), { force: true });
  });

  it('refuses while another process holds the repo write lock', async () => {
    const dir = repo();
    const engine = await approvedRoom(dir, { lock: { timeoutMs: 200, pollMs: 20 } });
    mkdirSync(locksDir(), { recursive: true });
    writeFileSync(
      lockPathFor(engine.room.repoRoot),
      JSON.stringify({ pid: process.pid, subject: engine.room.repoRoot, acquiredAt: 'now' }),
    );

    await expect(engine.merge()).rejects.toThrow(/timed out waiting for the write lock/);
    expect(readFileSync(join(dir, 'math.js'), 'utf8')).toBe(BROKEN);
    // And the room lock it took on the way in is handed back, not leaked.
    expect(existsSync(roomLockPath(engine.room.id))).toBe(false);

    rmSync(lockPathFor(engine.room.repoRoot), { force: true });
  });

  it('refuses a `--no-worktree` room, whose checkout is standing on the room branch', async () => {
    // Without a worktree the room branches in place, so the checkout is sitting on
    // `acr/<slug>` – merging would mean switching branches under the human, which is
    // theirs to do. The refusal names both branches rather than doing it for them.
    const dir = repo();
    const engine = await approvedRoom(dir, { worktree: false });
    const trunkBefore = gitIn(dir, 'rev-parse', 'main');

    const result = await engine.merge();

    expect(result.ok).toBe(false);
    expect(result.error).toContain(engine.room.roomBranch);
    expect(result.error).toContain('main');
    expect(gitIn(dir, 'rev-parse', 'main')).toBe(trunkBefore);
  });
});
