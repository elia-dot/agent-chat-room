import type {
  EngineEvent,
  Message,
  Participant,
  Room,
  TurnEvent,
  TurnRecord,
} from '@agent-chat-room/core';

/**
 * A turn that is still streaming: a bubble with no persisted `Message` behind it yet.
 *
 * The transcript renders these after the persisted messages, and `message.done` swaps one
 * for the real row. Keeping them in a separate list rather than faking a `Message` means
 * nothing downstream has to wonder whether a `Message` it is holding is real.
 */
export interface PendingMessage {
  messageId: string;
  author: string;
  role: string;
  round: number;
  text: string;
  activity: TurnEvent[];
}

export interface RoomView {
  room: Room | null;
  participants: Participant[];
  messages: Message[];
  turns: TurnRecord[];
  pending: PendingMessage[];
  /** True while the server says a loop is in flight for this room. */
  running: boolean;
}

export const emptyRoom: RoomView = {
  room: null,
  participants: [],
  messages: [],
  turns: [],
  pending: [],
  running: false,
};

/** A snapshot frame, as `packages/server/src/ws.ts` sends it. */
export interface Snapshot {
  type: 'snapshot';
  roomId: string;
  room: Room;
  participants: Participant[];
  messages: Message[];
  turns: TurnRecord[];
  live: PendingMessage[];
  running: boolean;
}

export type IncomingFrame =
  Snapshot | EngineEvent | { type: 'error'; message: string; roomId?: string } | { type: 'pong' };

/**
 * The reducer, deliberately pure and exported.
 *
 * This is the whole reason there are no DOM tests in M2: everything that could plausibly
 * be wrong about streaming a transcript – ordering, a `done` with no `start`, an event for
 * a room you are not looking at – is decided here, where a test can just call it.
 */
export function applyEvent(state: RoomView, frame: IncomingFrame): RoomView {
  switch (frame.type) {
    case 'snapshot':
      // A snapshot is authoritative. The client re-fetches one on every reconnect rather
      // than trusting accumulated text, because a delta dropped while the socket was down
      // would otherwise leave a bubble permanently truncated.
      return {
        room: frame.room,
        participants: frame.participants,
        messages: frame.messages,
        turns: frame.turns,
        pending: frame.live,
        running: frame.running,
      };

    case 'room.state': {
      if (!belongs(state, frame.roomId)) return state;
      const room = state.room ? { ...state.room, state: frame.state, round: frame.round } : null;
      return { ...state, room, running: isBusy(frame.state) };
    }

    case 'room.paused': {
      if (!belongs(state, frame.roomId)) return state;
      return {
        ...state,
        room: state.room ? { ...state.room, paused: frame.paused } : null,
      };
    }

    case 'message.start': {
      if (!belongs(state, frame.roomId)) return state;
      if (state.pending.some((p) => p.messageId === frame.messageId)) return state;
      return {
        ...state,
        running: true,
        pending: [
          ...state.pending,
          {
            messageId: frame.messageId,
            author: frame.author,
            role: frame.role,
            round: frame.round,
            text: '',
            activity: [],
          },
        ],
      };
    }

    case 'message.delta': {
      if (!belongs(state, frame.roomId)) return state;
      const known = state.pending.some((p) => p.messageId === frame.messageId);
      // A delta with no `start` happens when the socket reconnected mid-turn. Opening a
      // bubble for it is strictly better than dropping the text on the floor.
      const pending = known
        ? state.pending.map((p) =>
            p.messageId === frame.messageId ? { ...p, text: p.text + frame.text } : p,
          )
        : [
            ...state.pending,
            {
              messageId: frame.messageId,
              author: 'agent',
              role: '',
              round: state.room?.round ?? 0,
              text: frame.text,
              activity: [],
            },
          ];
      return { ...state, pending };
    }

    case 'message.done': {
      if (!belongs(state, frame.roomId)) return state;
      const pending = state.pending.filter((p) => p.messageId !== frame.message.id);
      // The store assigns `seq`, so re-sorting is what keeps the transcript in the order
      // the database will hand back on the next reload.
      const messages = state.messages.some((m) => m.id === frame.message.id)
        ? state.messages.map((m) => (m.id === frame.message.id ? frame.message : m))
        : [...state.messages, frame.message].sort((a, b) => a.seq - b.seq);
      return { ...state, messages, pending };
    }

    case 'turn.activity': {
      if (!belongs(state, frame.roomId)) return state;
      // Attributed to the one streaming turn, for the same reason the server's buffer does
      // it that way: `turn.activity` is keyed by turn and `message.start` by message.
      if (state.pending.length !== 1) return state;
      return {
        ...state,
        pending: state.pending.map((p) => ({ ...p, activity: [...p.activity, frame.event] })),
      };
    }

    default:
      return state;
  }
}

function belongs(state: RoomView, roomId: string): boolean {
  return state.room?.id === roomId;
}

function isBusy(state: string): boolean {
  return state === 'running' || state === 'waiting-reviews';
}

/**
 * A tiny `useSyncExternalStore`-compatible store.
 *
 * React state would work too, but every WebSocket frame would then have to travel through
 * a component, and the socket lives outside the tree. This keeps the socket the owner and
 * the components readers.
 */
export class RoomStoreClient {
  private state: RoomView = emptyRoom;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): RoomView => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Point the store at a different room. Clears everything: nothing carries over. */
  reset(): void {
    this.state = emptyRoom;
    this.emit();
  }

  apply(frame: IncomingFrame): void {
    const next = applyEvent(this.state, frame);
    if (next === this.state) return;
    this.state = next;
    this.emit();
  }

  /** Local edits from a REST response, so a button does not have to wait for the socket. */
  merge(patch: Partial<RoomView>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
