import type { Message, Participant, Room } from '@agent-chat-room/core';
import { describe, expect, it } from 'vitest';

import type { IncomingFrame, RoomView, Snapshot } from '../src/state/roomStore.js';
import { RoomStoreClient, applyEvent, emptyRoom } from '../src/state/roomStore.js';

const ROOM_ID = 'room-1';

const room = (over: Partial<Room> = {}): Room => ({
  id: ROOM_ID,
  slug: 'fix-add',
  title: 'Fix add()',
  task: 'add subtracts',
  mode: 'build-review',
  repoRoot: '/repo',
  additionalDirs: [],
  baseBranch: 'main',
  roomBranch: 'acr/fix-add',
  baseSha: 'abc1234',
  worktreePath: '/wt',
  state: 'idle',
  paused: false,
  nextSpeaker: null,
  round: 0,
  maxRounds: 4,
  prUrl: null,
  createdAt: 'then',
  updatedAt: 'then',
  closedAt: null,
  ...over,
});

const message = (id: string, seq: number, over: Partial<Message> = {}): Message => ({
  id,
  seq,
  roomId: ROOM_ID,
  participantId: 'p1',
  author: 'claude',
  role: 'worker',
  round: 1,
  kind: 'agent',
  text: 'done',
  verdict: null,
  activity: [],
  diff: null,
  diffPath: null,
  createdAt: 'then',
  ...over,
});

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  type: 'snapshot',
  roomId: ROOM_ID,
  room: room(),
  participants: [],
  messages: [],
  turns: [],
  live: [],
  running: false,
  ...over,
});

/** Fold a list of frames, the way the socket does. */
const fold = (frames: IncomingFrame[], from: RoomView = emptyRoom): RoomView =>
  frames.reduce(applyEvent, from);

describe('applyEvent', () => {
  it('takes a snapshot as the truth, including a turn already in flight', () => {
    const state = applyEvent(
      emptyRoom,
      snapshot({
        messages: [message('m1', 1)],
        running: true,
        live: [
          {
            messageId: 'm2',
            author: 'codex',
            role: 'reviewer',
            round: 1,
            text: 'half a review',
            activity: [],
          },
        ],
      }),
    );

    expect(state.room?.id).toBe(ROOM_ID);
    expect(state.messages.map((m) => m.id)).toEqual(['m1']);
    // Connecting mid-turn shows what has been said, not an empty bubble.
    expect(state.pending[0]?.text).toBe('half a review');
    expect(state.running).toBe(true);
  });

  it('streams a message: start opens a bubble, deltas append, done replaces it', () => {
    const state = fold([
      snapshot(),
      {
        type: 'message.start',
        roomId: ROOM_ID,
        messageId: 'm1',
        author: 'claude',
        role: 'worker',
        round: 1,
      },
      { type: 'message.delta', roomId: ROOM_ID, messageId: 'm1', text: 'Root ' },
      { type: 'message.delta', roomId: ROOM_ID, messageId: 'm1', text: 'cause: ' },
      { type: 'message.delta', roomId: ROOM_ID, messageId: 'm1', text: 'a race.' },
    ]);
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]!.text).toBe('Root cause: a race.');
    expect(state.pending[0]!.author).toBe('claude');
    expect(state.messages).toHaveLength(0);

    const done = applyEvent(state, {
      type: 'message.done',
      roomId: ROOM_ID,
      message: message('m1', 1, { text: 'Root cause: a race.' }),
    });
    // Exactly one bubble at every moment: the pending one is replaced, not added to.
    expect(done.pending).toEqual([]);
    expect(done.messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('keeps two reviewers apart while they stream in parallel', () => {
    const state = fold([
      snapshot(),
      {
        type: 'message.start',
        roomId: ROOM_ID,
        messageId: 'a',
        author: 'codex',
        role: 'reviewer',
        round: 1,
      },
      {
        type: 'message.start',
        roomId: ROOM_ID,
        messageId: 'b',
        author: 'cursor',
        role: 'reviewer',
        round: 1,
      },
      { type: 'message.delta', roomId: ROOM_ID, messageId: 'a', text: 'from codex' },
      { type: 'message.delta', roomId: ROOM_ID, messageId: 'b', text: 'from cursor' },
    ]);
    expect(state.pending.map((p) => [p.author, p.text])).toEqual([
      ['codex', 'from codex'],
      ['cursor', 'from cursor'],
    ]);
  });

  it('opens a bubble for a delta with no start, rather than dropping the text', () => {
    // This is what a reconnect mid-turn looks like from the client's side.
    const state = fold([
      snapshot({ room: room({ round: 2 }) }),
      { type: 'message.delta', roomId: ROOM_ID, messageId: 'm9', text: 'orphaned' },
    ]);
    expect(state.pending).toEqual([
      { messageId: 'm9', author: 'agent', role: '', round: 2, text: 'orphaned', activity: [] },
    ]);
  });

  it('accepts a done with no preceding start, and never duplicates a message', () => {
    const persisted = message('m1', 1);
    const once = applyEvent(applyEvent(emptyRoom, snapshot()), {
      type: 'message.done',
      roomId: ROOM_ID,
      message: persisted,
    });
    expect(once.messages).toHaveLength(1);

    const twice = applyEvent(once, {
      type: 'message.done',
      roomId: ROOM_ID,
      message: { ...persisted, text: 'edited' },
    });
    expect(twice.messages).toHaveLength(1);
    expect(twice.messages[0]!.text).toBe('edited');
  });

  it('sorts a late message into sequence order rather than appending it', () => {
    const state = fold([
      snapshot({ messages: [message('m1', 1), message('m3', 3)] }),
      { type: 'message.done', roomId: ROOM_ID, message: message('m2', 2) },
    ]);
    expect(state.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('tracks room state and the pause flag separately, because they are separate', () => {
    const running = fold([
      snapshot(),
      { type: 'room.state', roomId: ROOM_ID, state: 'running', round: 1 },
    ]);
    expect(running.room?.state).toBe('running');
    expect(running.room?.round).toBe(1);
    expect(running.running).toBe(true);

    // A paused room sits in `idle`, which is also where restart recovery leaves one; the
    // flag is the only thing that tells them apart, so it has its own event.
    const paused = fold(
      [
        { type: 'room.state', roomId: ROOM_ID, state: 'idle', round: 1 },
        { type: 'room.paused', roomId: ROOM_ID, paused: true },
      ],
      running,
    );
    expect(paused.room?.state).toBe('idle');
    expect(paused.room?.paused).toBe(true);
    expect(paused.running).toBe(false);

    expect(
      applyEvent(paused, { type: 'room.paused', roomId: ROOM_ID, paused: false }).room?.paused,
    ).toBe(false);
  });

  it('attaches activity to the one streaming turn, and to none when there are two', () => {
    const one = fold([
      snapshot(),
      {
        type: 'message.start',
        roomId: ROOM_ID,
        messageId: 'a',
        author: 'claude',
        role: 'worker',
        round: 1,
      },
      {
        type: 'turn.activity',
        roomId: ROOM_ID,
        turnId: 't1',
        event: { type: 'tool', name: 'Read', summary: 'math.js' },
      },
    ]);
    expect(one.pending[0]!.activity).toHaveLength(1);

    const two = applyEvent(
      applyEvent(one, {
        type: 'message.start',
        roomId: ROOM_ID,
        messageId: 'b',
        author: 'codex',
        role: 'reviewer',
        round: 1,
      }),
      {
        type: 'turn.activity',
        roomId: ROOM_ID,
        turnId: 't2',
        event: { type: 'tool', name: 'Grep', summary: 'add' },
      },
    );
    // Guessing which of two parallel turns a tool call belongs to would be worse than
    // waiting for `message.done`, which carries the persisted list.
    expect(two.pending.map((p) => p.activity.length)).toEqual([1, 0]);
  });

  it('ignores every event for a room it is not looking at', () => {
    const state = applyEvent(emptyRoom, snapshot());
    const frames: IncomingFrame[] = [
      { type: 'message.delta', roomId: 'other', messageId: 'x', text: 'nope' },
      { type: 'message.done', roomId: 'other', message: message('x', 9) },
      { type: 'room.state', roomId: 'other', state: 'approved', round: 3 },
      { type: 'room.paused', roomId: 'other', paused: true },
      { type: 'error', message: 'something' },
      { type: 'pong' },
    ];
    for (const frame of frames) expect(applyEvent(state, frame)).toBe(state);
  });
});

describe('RoomStoreClient', () => {
  it('notifies subscribers only when something actually changed', () => {
    const client = new RoomStoreClient();
    let notifications = 0;
    const unsubscribe = client.subscribe(() => (notifications += 1));

    client.apply(snapshot());
    expect(notifications).toBe(1);
    expect(client.getSnapshot().room?.id).toBe(ROOM_ID);

    // An event for another room is not a re-render.
    client.apply({ type: 'room.paused', roomId: 'other', paused: true });
    expect(notifications).toBe(1);

    client.apply({ type: 'room.paused', roomId: ROOM_ID, paused: true });
    expect(notifications).toBe(2);

    client.reset();
    expect(client.getSnapshot()).toEqual(emptyRoom);

    unsubscribe();
    client.apply(snapshot());
    expect(notifications).toBe(3);
  });

  it('replaces the roster on room.roster, and ignores one for another room', () => {
    const roster = (role: string): Participant => ({
      id: 'p2',
      roomId: ROOM_ID,
      runtime: 'codex',
      role: role as Participant['role'],
      permission: 'edits',
      model: null,
      sessionId: null,
      orderIndex: 1,
      lastSeenMessageId: null,
    });

    const start = applyEvent(emptyRoom, snapshot());
    const swapped = applyEvent(start, {
      type: 'room.roster',
      roomId: ROOM_ID,
      participants: [roster('worker')],
    });
    // Wholesale, not a patch: a swap demotes the incumbent in the same step.
    expect(swapped.participants).toHaveLength(1);
    expect(swapped.participants[0]?.role).toBe('worker');

    const other = applyEvent(swapped, {
      type: 'room.roster',
      roomId: 'another-room',
      participants: [],
    });
    expect(other).toBe(swapped);
  });
});
