import { existsSync, readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_INLINE_DIFF_BYTES, RoomStore } from '../../src/store/rooms.js';
import { useTempConfigDir } from '../helpers.js';

let store: RoomStore;
let config: ReturnType<typeof useTempConfigDir>;

function room(overrides: Partial<Parameters<RoomStore['createRoom']>[0]> = {}) {
  return store.createRoom({
    slug: 'fix-add',
    title: 'Fix add()',
    task: 'add() subtracts',
    repoRoot: '/tmp/repo',
    baseBranch: 'main',
    roomBranch: 'acr/fix-add',
    baseSha: 'abc1234',
    ...overrides,
  });
}

beforeEach(() => {
  config = useTempConfigDir();
  store = RoomStore.open();
});

afterEach(() => {
  store.close();
  config.restore();
});

describe('RoomStore', () => {
  it('round-trips and updates additional folders', () => {
    const created = room({ additionalDirs: ['/shared/docs', '/shared/data'] });
    expect(created.additionalDirs).toEqual(['/shared/docs', '/shared/data']);
    expect(store.getRoom(created.id)?.additionalDirs).toEqual(['/shared/docs', '/shared/data']);

    const updated = store.updateRoom(created.id, { additionalDirs: ['/other'] });
    expect(updated.additionalDirs).toEqual(['/other']);
    expect(store.getRoom(created.id)?.additionalDirs).toEqual(['/other']);
  });

  it('round-trips the pause flag and the next speaker', () => {
    const r = room();
    expect(r.paused).toBe(false);
    expect(r.nextSpeaker).toBeNull();

    // `paused` is a boolean here and an INTEGER in the row, so it is worth pinning that it
    // survives the trip in both directions.
    const held = store.updateRoom(r.id, { paused: true, nextSpeaker: 'codex' });
    expect(held.paused).toBe(true);
    expect(held.nextSpeaker).toBe('codex');
    expect(store.getRoom(r.id)).toEqual(held);

    const released = store.updateRoom(r.id, { paused: false, nextSpeaker: null });
    expect(released.paused).toBe(false);
    expect(released.nextSpeaker).toBeNull();

    // Patching something else leaves both alone.
    const renamed = store.updateRoom(r.id, { paused: true });
    expect(store.updateRoom(r.id, { title: 'Renamed' }).paused).toBe(renamed.paused);
  });

  it('round-trips a room with its roster, transcript and turns', () => {
    const r = room();
    expect(store.getRoom(r.id)).toEqual(r);
    expect(r.state).toBe('idle');
    expect(r.maxRounds).toBe(4);

    const worker = store.addParticipant({
      roomId: r.id,
      runtime: 'echo',
      role: 'worker',
      permission: 'edits',
      orderIndex: 0,
    });
    store.addParticipant({
      roomId: r.id,
      runtime: 'echo',
      role: 'reviewer',
      permission: 'read-only',
      orderIndex: 1,
    });
    expect(store.listParticipants(r.id).map((p) => p.role)).toEqual(['worker', 'reviewer']);

    const message = store.addMessage({
      roomId: r.id,
      participantId: worker.id,
      author: 'echo',
      role: 'worker',
      round: 1,
      kind: 'agent',
      text: 'swapped the operator',
      activity: [{ type: 'file', path: 'math.js', op: 'edit' }],
      diff: '--- a\n+++ b\n',
    });
    expect(store.getMessage(message.id)?.activity).toEqual([
      { type: 'file', path: 'math.js', op: 'edit' },
    ]);
    expect(store.readDiff(message)).toBe('--- a\n+++ b\n');

    const turn = store.startTurn({
      roomId: r.id,
      participantId: worker.id,
      round: 1,
      role: 'worker',
      permission: 'edits',
    });
    expect(turn.endedAt).toBeNull();
    expect(store.unfinishedTurns(r.id)).toHaveLength(1);

    const finished = store.finishTurn(turn.id, {
      ok: true,
      exitCode: 0,
      sessionId: 'sess-1',
      usage: { inputTokens: 10 },
    });
    expect(finished.ok).toBe(true);
    expect(finished.usage).toEqual({ inputTokens: 10 });
    expect(store.unfinishedTurns(r.id)).toHaveLength(0);
  });

  it('stores a reviewer verdict as structured data, not as text to re-parse', () => {
    const r = room();
    const message = store.addMessage({
      roomId: r.id,
      author: 'echo',
      role: 'reviewer',
      round: 1,
      kind: 'agent',
      text: 'nope',
      verdict: { decision: 'request-changes', blocking: ['math.js:2 still wrong'], nits: [] },
    });
    expect(store.getMessage(message.id)?.verdict).toEqual({
      decision: 'request-changes',
      blocking: ['math.js:2 still wrong'],
      nits: [],
    });
  });

  it('selects exactly the messages a participant has not seen', () => {
    const r = room();
    const p = store.addParticipant({
      roomId: r.id,
      runtime: 'echo',
      role: 'reviewer',
      permission: 'read-only',
      orderIndex: 1,
    });

    const first = store.addMessage({ roomId: r.id, author: 'you', kind: 'user', text: 'task' });
    expect(store.messagesAfter(r.id, p.lastSeenMessageId)).toHaveLength(1);

    store.updateParticipant(p.id, { lastSeenMessageId: first.id });
    expect(store.messagesAfter(r.id, first.id)).toHaveLength(0);

    store.addMessage({ roomId: r.id, author: 'echo', kind: 'agent', text: 'worker r1', round: 1 });
    store.addMessage({ roomId: r.id, author: 'system', kind: 'system', text: '1 of 1', round: 1 });
    const unseen = store.messagesAfter(r.id, first.id);
    expect(unseen.map((m) => m.text)).toEqual(['worker r1', '1 of 1']);
  });

  it('spills a diff larger than the inline cap to a file', () => {
    const r = room();
    const huge = `${'x'.repeat(MAX_INLINE_DIFF_BYTES + 1024)}\n`;
    const message = store.addMessage({
      roomId: r.id,
      author: 'echo',
      role: 'worker',
      round: 1,
      kind: 'agent',
      text: 'big change',
      diff: huge,
    });

    expect(message.diff).toBeNull();
    expect(message.diffPath).toBeTruthy();
    expect(existsSync(message.diffPath!)).toBe(true);
    expect(readFileSync(message.diffPath!, 'utf8')).toBe(huge);
    // The caller does not have to know where it went.
    expect(store.readDiff(message)).toBe(huge);
  });

  it('cascades a delete to participants, messages and turns', () => {
    const r = room();
    const p = store.addParticipant({
      roomId: r.id,
      runtime: 'echo',
      role: 'worker',
      permission: 'edits',
      orderIndex: 0,
    });
    store.addMessage({ roomId: r.id, author: 'echo', kind: 'agent', text: 'x', round: 1 });
    store.startTurn({
      roomId: r.id,
      participantId: p.id,
      round: 1,
      role: 'worker',
      permission: 'edits',
    });

    store.deleteRoom(r.id);
    expect(store.getRoom(r.id)).toBeUndefined();
    expect(store.listParticipants(r.id)).toHaveLength(0);
    expect(store.listMessages(r.id)).toHaveLength(0);
    expect(store.listTurns(r.id)).toHaveLength(0);
  });

  it('rolls a round back and clears the watermarks that pointed into it', () => {
    const r = room();
    const p = store.addParticipant({
      roomId: r.id,
      runtime: 'echo',
      role: 'worker',
      permission: 'edits',
      orderIndex: 0,
    });
    const task = store.addMessage({ roomId: r.id, author: 'you', kind: 'user', text: 'task' });
    const round1 = store.addMessage({
      roomId: r.id,
      author: 'echo',
      kind: 'agent',
      text: 'r1',
      round: 1,
    });
    store.updateParticipant(p.id, { lastSeenMessageId: round1.id });

    expect(store.deleteMessagesFromRound(r.id, 1)).toBe(1);
    // The human's task survives a rollback; it is not something a turn produced.
    expect(store.listMessages(r.id).map((m) => m.id)).toEqual([task.id]);
    expect(store.getParticipant(p.id)?.lastSeenMessageId).toBeNull();
  });

  it('finds a room by id prefix, and refuses an ambiguous one', () => {
    const a = store.createRoom({
      id: 'aaaa1111-0000-0000-0000-000000000000',
      slug: 'a',
      title: 'A',
      task: 'a',
      repoRoot: '/tmp/repo',
      baseBranch: 'main',
      roomBranch: 'acr/a',
    });
    store.createRoom({
      id: 'aaaa2222-0000-0000-0000-000000000000',
      slug: 'b',
      title: 'B',
      task: 'b',
      repoRoot: '/tmp/repo',
      baseBranch: 'main',
      roomBranch: 'acr/b',
    });

    expect(store.findRoom('aaaa1111')?.id).toBe(a.id);
    expect(store.findRoom('a')?.slug).toBe('a');
    expect(() => store.findRoom('aaaa')).toThrow(/matches 2 rooms/);
    expect(store.findRoom('zzzz')).toBeUndefined();
  });

  it('remembers recent repos', () => {
    store.touchRepo('/tmp/repo-one', { agents: ['echo', 'echo'] });
    store.touchRepo('/tmp/repo-two');
    const repos = store.listRepos();
    expect(repos.map((r) => r.path)).toContain('/tmp/repo-one');
    expect(repos.find((r) => r.path === '/tmp/repo-one')?.defaults).toEqual({
      agents: ['echo', 'echo'],
    });
  });
});
