import { describe, expect, it } from 'vitest';

import { roomToMarkdown } from '../src/export.js';
import type { Message, Participant, Room, TurnRecord } from '../src/store/types.js';

const room = (over: Partial<Room> = {}): Room => ({
  id: 'room-1',
  slug: 'fix-add',
  title: 'Fix add()',
  task: 'math.js exports add() but the body subtracts. Fix it.',
  mode: 'build-review',
  repoRoot: '/repo',
  additionalDirs: [],
  baseBranch: 'main',
  roomBranch: 'acr/fix-add',
  baseSha: 'abc1234',
  worktreePath: '/wt',
  state: 'approved',
  paused: false,
  nextSpeaker: null,
  round: 2,
  maxRounds: 4,
  prUrl: null,
  createdAt: '2026-09-03T10:00:00.000Z',
  updatedAt: '2026-09-03T10:05:00.000Z',
  closedAt: null,
  ...over,
});

const participant = (over: Partial<Participant> = {}): Participant => ({
  id: 'p1',
  roomId: 'room-1',
  runtime: 'claude',
  role: 'worker',
  permission: 'edits',
  model: null,
  sessionId: 's1',
  orderIndex: 0,
  lastSeenMessageId: null,
  ...over,
});

const message = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  seq: 1,
  roomId: 'room-1',
  participantId: 'p1',
  author: 'claude',
  role: 'worker',
  round: 1,
  kind: 'agent',
  text: 'Swapped the operator.',
  verdict: null,
  activity: [],
  diff: null,
  diffPath: null,
  createdAt: '2026-09-03T10:01:00.000Z',
  ...over,
});

const turn = (over: Partial<TurnRecord> = {}): TurnRecord => ({
  id: 't1',
  roomId: 'room-1',
  participantId: 'p1',
  round: 1,
  role: 'worker',
  permission: 'edits',
  startedAt: '2026-09-03T10:01:00.000Z',
  endedAt: '2026-09-03T10:01:30.000Z',
  ok: true,
  exitCode: 0,
  error: null,
  usage: { totalTokens: 1200 },
  sessionId: 's1',
  logPath: null,
  ...over,
});

describe('roomToMarkdown', () => {
  it('opens with the room, its roster and its task', () => {
    const md = roomToMarkdown({
      room: room(),
      participants: [
        participant(),
        participant({
          id: 'p2',
          runtime: 'codex',
          role: 'reviewer',
          permission: 'read-only',
          model: 'gpt-5.3-codex',
        }),
      ],
      messages: [],
    });

    expect(md).toContain('# Fix add()');
    expect(md).toContain('**Branch** `acr/fix-add` from `main`');
    expect(md).toContain('**Mode** build-review');
    expect(md).toContain('- **claude** – worker, edits');
    expect(md).toContain('- **codex** – reviewer, read-only · model `gpt-5.3-codex`');
    expect(md).toContain('- **you** – owner');
    expect(md).toContain('math.js exports add()');
  });

  it('renders a verdict, its blocking items and the activity log', () => {
    const md = roomToMarkdown({
      room: room(),
      participants: [participant()],
      messages: [
        message({
          id: 'm2',
          author: 'codex',
          role: 'reviewer',
          verdict: {
            decision: 'request-changes',
            blocking: ['math.js:2 still subtracts'],
            nits: ['name it'],
          },
          activity: [
            { type: 'tool', name: 'bash', summary: 'npm test' },
            { type: 'file', path: 'math.js', op: 'edit' },
          ],
        }),
      ],
    });

    expect(md).toContain('### codex · reviewer · round 1 — **REQUEST CHANGES**');
    expect(md).toContain('- **blocking** math.js:2 still subtracts');
    expect(md).toContain('- nit: name it');
    expect(md).toContain('<details><summary>activity</summary>');
    expect(md).toContain('- `bash` npm test');
    expect(md).toContain('- edit `math.js`');
  });

  it('sets system lines apart from the people talking', () => {
    const md = roomToMarkdown({
      room: room(),
      participants: [participant()],
      messages: [
        message({
          kind: 'system',
          author: 'system',
          role: 'system',
          text: 'round 1: 2 of 2 approved.',
        }),
      ],
    });
    expect(md).toContain('> _round 1: 2 of 2 approved._');
    expect(md).not.toContain('### system');
  });

  it('inlines a diff, and names the file when the diff spilled to disk', () => {
    const inline = roomToMarkdown({
      room: room(),
      participants: [participant()],
      messages: [message({ diff: '--- a/math.js\n+++ b/math.js\n' })],
    });
    expect(inline).toContain('```diff');
    expect(inline).toContain('+++ b/math.js');

    const spilled = roomToMarkdown({
      room: room(),
      participants: [participant()],
      messages: [message({ diff: null, diffPath: '/config/diffs/m1.diff' })],
    });
    // Megabytes of diff pasted into an issue helps nobody; the path does.
    expect(spilled).not.toContain('```diff');
    expect(spilled).toContain('`/config/diffs/m1.diff`');
  });

  it('summarises usage, and says so when no runtime reported tokens', () => {
    const withTokens = roomToMarkdown({
      room: room(),
      participants: [participant()],
      messages: [],
      turns: [turn()],
    });
    expect(withTokens).toContain('1 turn · 30s of wall time · 1,200 tokens');

    const without = roomToMarkdown({
      room: room(),
      participants: [participant()],
      messages: [],
      turns: [turn({ usage: null })],
    });
    expect(without).toContain('tokens not reported');
  });

  it('links the pull request a room opened', () => {
    const md = roomToMarkdown({
      room: room({ prUrl: 'https://github.com/o/r/pull/7' }),
      participants: [participant()],
      messages: [],
    });
    expect(md).toContain('**Pull request** https://github.com/o/r/pull/7');
  });
});
