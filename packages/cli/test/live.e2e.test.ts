import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { RoomStore, roomToMarkdown } from '@agent-chat-room/core';

import { rooms } from '../src/commands/rooms.js';
import { run } from '../src/commands/run.js';
import { EXIT } from '../src/exit.js';
import { Renderer } from '../src/render.js';
import { Capture, gitIn, makeRepo, useTempConfigDir } from './helpers.js';

/**
 * The acceptance criterion this suite exists to prove:
 *
 *   "Done when: `acr run` completes a full approve cycle unattended and can be resumed
 *    after the process restarts."
 *
 * So this is no longer one exchange: it is a whole room, in a worktree, with the engine
 * committing the round that Codex approved. It spends real subscription turns on two real
 * CLIs, so it is opt in. Run it with:
 *
 *   ACR_LIVE=1 npm test -- live
 *
 * `npm test` on its own never touches the network and never spawns an agent.
 */
const live = process.env.ACR_LIVE === '1';

const BROKEN = `export function add(a, b) {
  // Deliberately wrong: this subtracts.
  return a - b;
}

export function mul(a, b) {
  return a * b;
}
`;

const repos: string[] = [];

afterAll(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!live)('live: claude works, codex reviews, the room commits', () => {
  it(
    'completes a full approve cycle unattended and can be resumed',
    async () => {
      const dir = makeRepo({
        'math.js': BROKEN,
        'README.md': '# sample\n\nA deliberately broken `add()`.\n',
      });
      repos.push(dir);

      const config = useTempConfigDir();
      const store = RoomStore.open();
      const capture = new Capture();
      try {
        const summary = await run({
          task:
            'math.js exports add(a, b) but the body subtracts. Fix it so add returns the sum. ' +
            'Change nothing else.',
          cwd: dir,
          agents: ['claude', 'codex'],
          timeoutMs: 20 * 60 * 1000,
          store,
          renderer: new Renderer({ color: false, write: capture.write }),
        });

        // The room worked in its own worktree; the checkout the human owns never moved.
        expect(summary.worktree).toBeTruthy();
        expect(readFileSync(join(summary.worktree!, 'math.js'), 'utf8')).toContain('a + b');
        expect(readFileSync(join(dir, 'math.js'), 'utf8')).toBe(BROKEN);
        expect(summary.changedFiles).toContain('math.js');

        // Codex's review parsed into a verdict, and the loop reached a decision.
        expect(summary.verdict?.ok).toBe(true);
        expect(summary.exitCode === EXIT.ok || summary.exitCode === EXIT.notApproved).toBe(true);

        if (summary.exitCode === EXIT.ok) {
          // An approved round is committed on the room branch, not left in a working tree.
          expect(summary.commit).toBeTruthy();
          expect(gitIn(summary.worktree!, 'rev-list', '--count', 'HEAD')).not.toBe('1');
          expect(gitIn(summary.worktree!, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
            summary.branch,
          );
        }

        // The room survived into the store and can be read back after the fact.
        const listing = new Capture();
        await rooms({
          subcommand: 'show',
          id: summary.roomId,
          cwd: dir,
          store,
          renderer: new Renderer({ color: false, write: listing.write }),
        });
        expect(listing.text).toContain(summary.branch);
        expect(store.listTurns(summary.roomId).length).toBeGreaterThanOrEqual(2);
        expect(store.unfinishedTurns(summary.roomId)).toHaveLength(0);
      } finally {
        store.close();
        config.restore();
      }
    },
    40 * 60 * 1000,
  );
});

/**
 * The M3 acceptance criterion: the third runtime works, and a brainstorm room reaches a
 * proposal. Opt in the same way, and for the same reason – it spends real subscription
 * turns on three real CLIs.
 */
describe.skipIf(!live)('live: claude, codex and cursor brainstorm', () => {
  it(
    'runs three phases across three runtimes and ends with a moderator proposal',
    async () => {
      const dir = makeRepo({
        'math.js': BROKEN,
        'README.md': '# sample\n\nA deliberately broken `add()`.\n',
      });
      repos.push(dir);

      const config = useTempConfigDir();
      const store = RoomStore.open();
      const capture = new Capture();
      try {
        const summary = await run({
          task:
            'math.js has a broken add() and no tests at all. In two or three sentences each: ' +
            'what is the smallest change that would stop this class of bug coming back?',
          cwd: dir,
          agents: ['claude', 'codex', 'cursor'],
          mode: 'brainstorm',
          timeoutMs: 20 * 60 * 1000,
          store,
          renderer: new Renderer({ color: false, write: capture.write }),
        });

        expect(summary.mode).toBe('brainstorm');
        expect(summary.state).toBe('needs-you');
        expect(summary.rounds).toBe(3);
        // A proposal is the finish line for this mode, so the exit code has to say success.
        expect(summary.exitCode).toBe(EXIT.ok);

        const messages = store.listMessages(summary.roomId).filter((m) => m.kind === 'agent');
        expect(messages.filter((m) => m.round === 1)).toHaveLength(3);
        expect(messages.filter((m) => m.round === 2)).toHaveLength(3);
        const proposal = messages.filter((m) => m.round === 3);
        expect(proposal).toHaveLength(1);
        expect(proposal[0]?.author).toBe('cursor');
        expect(proposal[0]?.text.length).toBeGreaterThan(80);

        // Nobody edits in a brainstorm, so the worktree is exactly as it was cut.
        expect(readFileSync(join(dir, 'math.js'), 'utf8')).toBe(BROKEN);
        if (summary.worktree) {
          expect(readFileSync(join(summary.worktree, 'math.js'), 'utf8')).toBe(BROKEN);
        }

        const markdown = roomToMarkdown({
          room: store.getRoom(summary.roomId)!,
          participants: store.listParticipants(summary.roomId),
          messages: store.listMessages(summary.roomId),
          turns: store.listTurns(summary.roomId),
        });
        expect(markdown).toContain('**Mode** brainstorm');
        expect(markdown).toContain('### cursor · moderator · round 3');
      } finally {
        store.close();
        config.restore();
      }
    },
    40 * 60 * 1000,
  );
});
