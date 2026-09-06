import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { echoAdapter, resetEchoAdapter } from '../../src/adapters/echo.js';
import type { AdditionalDirInput } from '../../src/config.js';
import { RoomEngine } from '../../src/engine/room.js';
import { RoomStore } from '../../src/store/rooms.js';
import type { AgentAdapter, TurnRequest } from '../../src/types.js';
import { gitIn, makeRepo, useTempConfigDir, writeEchoScript } from '../helpers.js';

const BROKEN = 'export function add(a, b) {\n  return a - b;\n}\n';
const APP_BEFORE = 'const token = "plaintext";\n';
const APP_AFTER = 'const token = secureStore.read();\n';

const verdict = (decision: string, blocking: string[] = []): string =>
  `Review body.\n\n\`\`\`verdict\n${JSON.stringify({ decision, blocking, nits: [] })}\n\`\`\``;

let config: ReturnType<typeof useTempConfigDir>;
let store: RoomStore;
const repos: string[] = [];
const requests: TurnRequest[] = [];

const spyEcho: AgentAdapter = {
  ...echoAdapter,
  capabilities: { ...echoAdapter.capabilities, structuredOutput: true },
  run(req, sink) {
    requests.push(req);
    return echoAdapter.run(req, sink);
  },
};

/** `realpath`, because that is the form the engine canonicalises additional dirs into. */
function repo(files: Record<string, string>): string {
  const dir = makeRepo(files);
  repos.push(dir);
  return realpathSync(dir);
}

function open(dir: string, additionalDirs: AdditionalDirInput[]): Promise<RoomEngine> {
  return RoomEngine.create(
    {
      task: 'Move the token into the OS secure store.',
      cwd: dir,
      agents: ['echo', 'echo'],
      additionalDirs,
    },
    { store, adapters: { echo: spyEcho }, timeoutMs: 5000 },
  );
}

/** A bare repo on disk standing in for a forge, so a push in a test opens no socket. */
function remoteFor(repoDir: string): void {
  const bare = join(mkdtempSync(join(tmpdir(), 'acr-remote-')), 'origin.git');
  repos.push(dirname(bare));
  execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'pipe' });
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repoDir, stdio: 'pipe' });
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

describe('additional folders are part of the room', () => {
  it('shows their changes to the reviewer and commits them with the round', async () => {
    const dir = repo({ 'math.js': BROKEN });
    const app = repo({ 'auth.js': APP_BEFORE });
    process.env.ACR_ECHO_SCRIPT = writeEchoScript({
      turns: [
        {
          when: { role: 'worker', round: 1 },
          text: 'Read the token out of the secure store instead.',
          // The whole change lands in the additional folder, not in the room repo.
          writeFiles: { [join(app, 'auth.js')]: APP_AFTER },
        },
        { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
      ],
    });

    const engine = await open(dir, [app]);
    const outcome = await engine.run();

    expect(outcome.state).toBe('approved');
    expect(outcome.changedFiles).toEqual([`${app}/auth.js`]);

    // The reviewer was shown the change rather than an empty diff.
    const review = requests.find((r) => r.prompt.includes('acting as REVIEWER'))!;
    expect(review.prompt).toContain(`additional folder ${app}`);
    expect(review.prompt).toContain(APP_AFTER.trim());

    // And nobody was told the worker did nothing.
    const messages = store.listMessages(engine.room.id);
    expect(messages.some((m) => m.text.includes('the worker changed no files'))).toBe(false);

    // The approved round is committed in the additional repo, on its own branch.
    expect(gitIn(app, 'status', '--porcelain')).toBe('');
    expect(gitIn(app, 'log', '-1', '--pretty=%s')).toContain('acr: ');
    expect(gitIn(app, 'rev-list', '--count', 'HEAD')).toBe('2');
    expect(
      messages.some(
        (m) => m.kind === 'system' && m.text.includes(`committed`) && m.text.includes(app),
      ),
    ).toBe(true);
  });

  it('says up front when an additional folder is already dirty', async () => {
    const dir = repo({ 'math.js': BROKEN });
    const app = repo({ 'auth.js': APP_BEFORE });
    writeFileSync(join(app, 'auth.js'), 'my own unfinished work\n');

    const engine = await open(dir, [app]);
    const warning = store
      .listMessages(engine.room.id)
      .find((m) => m.kind === 'system' && m.text.includes('Already uncommitted'));
    expect(warning?.text).toContain(app);
  });

  it('ignores a folder that is not in a repository', async () => {
    const dir = repo({ 'math.js': BROKEN });
    process.env.ACR_ECHO_SCRIPT = writeEchoScript({
      turns: [
        {
          when: { role: 'worker', round: 1 },
          text: 'Fixed it in the room repo.',
          writeFiles: { 'math.js': 'export function add(a, b) {\n  return a + b;\n}\n' },
        },
        { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
      ],
    });

    // A folder with no repository contributes nothing: there is no diff to collect there
    // and nothing to commit, so it is accepted and then simply never appears.
    const engine = await open(dir, [config.dir]);
    const outcome = await engine.run();

    expect(outcome.state).toBe('approved');
    expect(outcome.changedFiles).toEqual(['math.js']);
    expect(outcome.commit).toBeTruthy();
    const diff = store
      .listMessages(engine.room.id)
      .find((m) => m.author === 'echo' && m.role === 'worker')?.diff;
    expect(diff).not.toContain('additional folder');
  });
});

describe('read-only additional folders', () => {
  it('reverts what a turn changed there and says so', async () => {
    const dir = repo({ 'math.js': BROKEN });
    const app = repo({ 'auth.js': APP_BEFORE });
    process.env.ACR_ECHO_SCRIPT = writeEchoScript({
      turns: [
        {
          when: { role: 'worker', round: 1 },
          text: 'Edited the folder I was told not to edit.',
          writeFiles: {
            [join(app, 'auth.js')]: APP_AFTER,
            [join(app, 'invented.dart')]: 'brand new\n',
            'math.js': 'export function add(a, b) {\n  return a + b;\n}\n',
          },
        },
        { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
      ],
    });

    const engine = await open(dir, [{ path: app, access: 'read' }]);
    const outcome = await engine.run();

    expect(outcome.state).toBe('approved');
    // The folder is exactly as the turn found it: edit undone, new file gone, nothing
    // committed, and its HEAD untouched.
    expect(readFileSync(join(app, 'auth.js'), 'utf8')).toBe(APP_BEFORE);
    expect(existsSync(join(app, 'invented.dart'))).toBe(false);
    expect(gitIn(app, 'status', '--porcelain')).toBe('');
    expect(gitIn(app, 'rev-list', '--count', 'HEAD')).toBe('1');

    // Only the room repo's work survives, and the transcript says what was undone.
    expect(outcome.changedFiles).toEqual(['math.js']);
    const messages = store.listMessages(engine.room.id);
    const notice = messages.find((m) => m.kind === 'system' && m.text.includes('read-only'));
    expect(notice?.text).toContain('auth.js');
    expect(notice?.text).toContain('invented.dart');
  });

  it('leaves a file the human had already modified, and says why', async () => {
    const dir = repo({ 'math.js': BROKEN });
    const app = repo({ 'auth.js': APP_BEFORE });
    // The human's own unfinished work, sitting there before the room ran.
    writeFileSync(join(app, 'auth.js'), 'my own unfinished work\n');
    process.env.ACR_ECHO_SCRIPT = writeEchoScript({
      turns: [
        {
          when: { role: 'worker', round: 1 },
          text: 'Edited it anyway.',
          writeFiles: { [join(app, 'auth.js')]: APP_AFTER },
        },
        { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
      ],
    });

    const engine = await open(dir, [{ path: app, access: 'read' }]);
    await engine.run();

    // Restoring from HEAD would have destroyed the human's edit, so it is reported instead.
    expect(readFileSync(join(app, 'auth.js'), 'utf8')).toBe(APP_AFTER);
    const kept = store
      .listMessages(engine.room.id)
      .find((m) => m.kind === 'system' && m.text.includes('could not be put back'));
    expect(kept?.text).toContain('auth.js');
  });

  it('refuses a folder inside the checkout an isolated room is kept out of', async () => {
    // These rooms take a worktree, so the checkout is not where they work – granting it
    // back would undo the isolation rather than merely repeat it.
    const dir = repo({ 'math.js': BROKEN });
    mkdirSync(join(dir, 'packages'));
    await expect(open(dir, [{ path: join(dir, 'packages'), access: 'read' }])).rejects.toThrow(
      /keeps the agents out of/,
    );
    await expect(open(dir, [dir])).rejects.toThrow(/keeps the agents out of/);
  });

  it('refuses a folder that contains the room repo, not only one inside it', async () => {
    // The containment test used to look only downwards. Granting an *ancestor* was accepted,
    // which is the worse half of the same hole: that folder contains the checkout, so every
    // agent gets write access to the tree the worktree exists to protect – and since the
    // parent is usually not a repository itself, `additionalRepos` then drops it, so nothing
    // is diffed, committed or reverted there either. Silent, total access.
    const dir = repo({ 'math.js': BROKEN });
    const parent = dirname(dir);

    await expect(open(dir, [parent])).rejects.toThrow(/overlaps/);
    await expect(open(dir, [{ path: parent, access: 'read' }])).rejects.toThrow(/overlaps/);
  });

  it('still accepts a sibling folder, which overlaps nothing', async () => {
    // The guard has to refuse containment, not proximity: the ordinary case is another
    // repository next door, and that must keep working.
    const dir = repo({ 'math.js': BROKEN });
    const sibling = repo({ 'auth.js': APP_BEFORE });

    const engine = await open(dir, [sibling]);
    expect(engine.room.additionalDirs.map((d) => d.path)).toEqual([sibling]);
  });

  it('drops, rather than refuses, a grant for the folder the room already works in', async () => {
    // Without a worktree the checkout *is* the workspace, so naming it as an extra folder
    // is redundant, not an escalation: its changes are already in the room's diff and
    // collecting them again would commit them twice. A committed `.acr.json` that happens
    // to name a path inside the repo must not hard-fail every room opened there.
    const dir = repo({ 'math.js': BROKEN });
    mkdirSync(join(dir, 'packages'));

    const engine = await RoomEngine.create(
      {
        task: 'x',
        cwd: dir,
        agents: ['echo', 'echo'],
        worktree: false,
        additionalDirs: [dir, join(dir, 'packages')],
      },
      { store, adapters: { echo: spyEcho }, timeoutMs: 5000 },
    );

    expect(engine.room.worktreePath).toBeNull();
    expect(engine.room.additionalDirs).toEqual([]);
  });

  it('refuses read-only access to a folder with no repository to revert against', async () => {
    const dir = repo({ 'math.js': BROKEN });
    const plain = mkdtempSync(join(tmpdir(), 'acr-plain-'));
    repos.push(plain);
    await expect(open(dir, [{ path: plain, access: 'read' }])).rejects.toThrow(
      /not in a git repository/,
    );
    // Write access has nothing to enforce, so a plain folder is fine there.
    const engine = await open(dir, [{ path: plain, access: 'write' }]);
    expect(engine.room.additionalDirs.map((d) => d.access)).toEqual(['write']);
  });
});

describe('a writable additional folder gets a branch and a pull request of its own', () => {
  it('branches on first commit and opens a PR in every affected repo', async () => {
    const dir = repo({ 'math.js': BROKEN });
    const app = repo({ 'auth.js': APP_BEFORE });
    remoteFor(dir);
    remoteFor(app);
    process.env.ACR_ECHO_SCRIPT = writeEchoScript({
      turns: [
        {
          when: { role: 'worker', round: 1 },
          text: 'Changed both repos.',
          writeFiles: {
            'math.js': 'export function add(a, b) {\n  return a + b;\n}\n',
            [join(app, 'auth.js')]: APP_AFTER,
          },
        },
        { when: { role: 'reviewer', round: 1 }, text: verdict('approve') },
      ],
    });

    const engine = await open(dir, [{ path: app, access: 'write' }]);
    expect((await engine.run()).state).toBe('approved');

    // The additional repo is on a branch of the room's own, cut from the branch it was on.
    const granted = engine.room.additionalDirs[0]!;
    expect(granted.branch).toBe(`acr/${engine.room.slug}`);
    expect(granted.baseBranch).toBe('main');
    expect(gitIn(app, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(granted.branch);
    expect(gitIn(app, 'rev-list', '--count', 'main..HEAD')).toBe('1');

    const calls: string[][] = [];
    const result = await engine.openPr({
      gh: (args) => {
        calls.push(args);
        return Promise.resolve({ code: 0, stdout: 'https://github.com/o/r/pull/7\n', stderr: '' });
      },
    });

    expect(result.ok).toBe(true);
    // One pull request per repository, each against the branch that repository was on.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(
      expect.arrayContaining(['pr', 'create', '--head', engine.room.roomBranch]),
    );
    expect(calls[1]).toEqual(expect.arrayContaining(['pr', 'create', '--head', granted.branch!]));
    expect(engine.room.prUrl).toBe('https://github.com/o/r/pull/7');
    expect(engine.room.additionalDirs[0]!.prUrl).toBe('https://github.com/o/r/pull/7');
  });
});
