import { describe, expect, it } from 'vitest';

import type { Message, Room } from '@agent-chat-room/core';

import { Renderer, formatUsage } from '../src/render.js';
import { Capture } from './helpers.js';

const message = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  seq: 1,
  roomId: 'r1',
  participantId: 'p1',
  author: 'codex',
  role: 'reviewer',
  round: 1,
  kind: 'agent',
  text: 'Looks right.',
  verdict: null,
  activity: [],
  diff: null,
  diffPath: null,
  createdAt: '2026-09-03T00:00:00.000Z',
  ...over,
});

const room = (over: Partial<Room> = {}): Room => ({
  id: 'aaaabbbb-cccc-dddd-eeee-ffff00001111',
  slug: 'fix-add',
  title: 'Fix add()',
  task: 'add subtracts',
  mode: 'build-review',
  repoRoot: '/repo',
  additionalDirs: [],
  baseBranch: 'main',
  roomBranch: 'acr/fix-add',
  baseSha: 'abc1234',
  paused: false,
  nextSpeaker: null,
  worktreePath: '/wt',
  state: 'approved',
  round: 2,
  maxRounds: 4,
  prUrl: null,
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:00.000Z',
  closedAt: null,
  ...over,
});

const ESC = '\u001b';

function plain(): { r: Renderer; c: Capture } {
  const c = new Capture();
  return { r: new Renderer({ color: false, write: c.write }), c };
}

describe('Renderer', () => {
  it('writes no escape sequences when colour is off', () => {
    const { r, c } = plain();
    r.header('claude', 'worker', 1);
    r.event({ type: 'text', text: 'hello' });
    r.event({ type: 'done', text: 'hello' });
    expect(c.text).not.toContain(ESC);
    expect(c.text).toContain('[claude · worker · r1]');
    expect(c.text).toContain('hello');
  });

  it('paints runtimes differently when colour is on', () => {
    const c = new Capture();
    const r = new Renderer({ color: true, write: c.write });
    r.header('claude', 'worker', 1);
    r.header('codex', 'reviewer', 1);
    expect(c.text).toContain(`${ESC}[38;5;208m`);
    expect(c.text).toContain(`${ESC}[38;5;42m`);
  });

  it('keeps streaming text and dim activity lines from running together', () => {
    const { r, c } = plain();
    r.event({ type: 'text', text: 'thinking' });
    r.event({ type: 'tool', name: 'Read', summary: 'math.js' });
    expect(c.text).toBe('thinking\n  · Read math.js\n');
  });

  it('renders a verdict pill with blockers and nits', () => {
    const { r, c } = plain();
    r.verdict({
      ok: true,
      raw: '{}',
      verdict: { decision: 'request-changes', blocking: ['a.ts:1 wrong'], nits: ['rename it'] },
    });
    expect(c.text).toContain('REQUEST CHANGES');
    expect(c.text).toContain('blocking: a.ts:1 wrong');
    expect(c.text).toContain('nit: rename it');
  });

  it('prints a round separator once, when the round starts', () => {
    const { r, c } = plain();
    r.engineEvent({ type: 'room.state', roomId: 'r1', state: 'running', round: 1 });
    r.engineEvent({ type: 'room.state', roomId: 'r1', state: 'waiting-reviews', round: 1 });
    r.engineEvent({ type: 'room.state', roomId: 'r1', state: 'running', round: 2 });
    const separators = c.text.split('\n').filter((l) => l.includes('---- round'));
    expect(separators).toEqual(['---- round 1 ----', '---- round 2 ----']);
  });

  it('streams message deltas and renders the verdict when the message lands', () => {
    const { r, c } = plain();
    r.engineEvent({
      type: 'message.start',
      roomId: 'r1',
      messageId: 'm1',
      author: 'codex',
      role: 'reviewer',
      round: 1,
    });
    r.engineEvent({ type: 'message.delta', roomId: 'r1', messageId: 'm1', text: 'Looks right.' });
    r.engineEvent({
      type: 'turn.activity',
      roomId: 'r1',
      turnId: 't1',
      event: { type: 'tool', name: 'Read', summary: 'math.js' },
    });
    r.engineEvent({
      type: 'message.done',
      roomId: 'r1',
      message: message({ verdict: { decision: 'approve', blocking: [], nits: [] } }),
    });

    expect(c.text).toContain('[codex · reviewer · r1]');
    expect(c.text).toContain('Looks right.');
    expect(c.text).toContain('· Read math.js');
    expect(c.text).toContain('APPROVE');
  });

  it('renders a system message as a transcript aside', () => {
    const { r, c } = plain();
    r.engineEvent({
      type: 'message.done',
      roomId: 'r1',
      message: message({
        kind: 'system',
        role: 'system',
        author: 'system',
        text: '1 of 1 approved.',
      }),
    });
    expect(c.text).toContain('-- 1 of 1 approved.');
  });

  it('closes a run with where the room ended up', () => {
    const { r, c } = plain();
    r.outcome({
      roomId: 'r1',
      state: 'approved',
      mode: 'build-review',
      round: 2,
      approved: true,
      paused: false,
      commit: 'deadbee',
      changedFiles: ['math.js'],
    });
    expect(c.text).toContain('APPROVED');
    expect(c.text).toContain('after 2 rounds');
    expect(c.text).toContain('commit deadbee');
    expect(c.text).toContain('changed: math.js');
  });

  it('lists a room with its state, round and branch', () => {
    const { r, c } = plain();
    r.roomLine(room());
    expect(c.text).toContain('aaaabbbb');
    expect(c.text).toContain('Fix add()');
    expect(c.text).toContain('approved · round 2/4 · acr/fix-add');
  });

  it('says so when there is no verdict', () => {
    const { r, c } = plain();
    r.verdict({ ok: false, reason: 'no verdict block found in the reviewer message' });
    expect(c.text).toContain('no verdict');
  });
});

describe('formatUsage', () => {
  it('formats what a runtime reported and nothing else', () => {
    expect(formatUsage({ inputTokens: 6, outputTokens: 218, cachedInputTokens: 68800 })).toBe(
      'tokens: in 6 · cached 68800 · out 218',
    );
    expect(formatUsage({})).toBe('');
  });
});
