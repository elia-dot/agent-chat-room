import type { Message, Participant, RoomState } from '../store/types.js';
import type { TurnEvent } from '../types.js';

/**
 * The event names in PLAN.md section 4.4, defined in the engine rather than in the server
 * so that M2's WebSocket is a pass-through: the CLI renderer and the future web client
 * consume one shape, and nothing has to be re-derived when the socket lands.
 */
export type EngineEvent =
  | {
      type: 'room.state';
      roomId: string;
      state: RoomState;
      round: number;
      /**
       * The human's own action put the room here – reopening an approved room by naming an
       * agent is the only case so far. A desktop notification saying "the room is waiting
       * on you" is wrong when you are the one who just typed, so the server skips it.
       */
      byYou?: boolean;
    }
  /**
   * Not in PLAN.md section 4.4, because pausing is not a state. A browser watching a room
   * that another client paused has to learn about it without polling, and the sidebar dot
   * reads the flag rather than the state.
   */
  | { type: 'room.paused'; roomId: string; paused: boolean }
  /**
   * The roster changed: a role swap or a model change. Also not in PLAN.md section 4.4, and
   * there for the same reason `room.paused` is – a second tab has to learn that the worker
   * is now somebody else without polling.
   */
  | { type: 'room.roster'; roomId: string; participants: Participant[] }
  | {
      type: 'message.start';
      roomId: string;
      messageId: string;
      author: string;
      role: string;
      round: number;
    }
  | { type: 'message.delta'; roomId: string; messageId: string; text: string }
  /** A started message whose turn failed and therefore has no persisted Message row. */
  | { type: 'message.failed'; roomId: string; messageId: string; error: string }
  | { type: 'message.done'; roomId: string; message: Message }
  | { type: 'turn.activity'; roomId: string; turnId: string; event: TurnEvent };

export type EngineEventSink = (event: EngineEvent) => void;

/**
 * Adapts one turn's `TurnEvent` stream into engine events while accumulating what the
 * store needs: the final text, the collapsed activity log, and the runtime's session id.
 *
 * `message.done` is deliberately *not* emitted from here – it carries the persisted
 * `Message`, so only the engine, which does the writing, can emit it.
 */
export class TurnStream {
  text = '';
  sessionId: string | undefined;
  readonly activity: TurnEvent[] = [];
  /** True when a tool call has landed since the last prose, so the next prose is a new paragraph. */
  private interrupted = false;

  constructor(
    private readonly roomId: string,
    private readonly turnId: string,
    private readonly messageId: string,
    private readonly emit: EngineEventSink,
  ) {}

  /** Feed one adapter event. Never throws: a bad event must not take a turn down. */
  push(event: TurnEvent): void {
    switch (event.type) {
      case 'started':
        this.sessionId = event.sessionId;
        this.activityEvent(event);
        return;
      case 'text': {
        if (event.text.length === 0) return;
        // Runtimes emit one `text` event per content block, and a block that follows a tool
        // call is a new paragraph, not a continuation. Concatenating them raw is what turns
        // "reading x." and "reading y." into "reading x. reading y." – so the break goes in
        // here, once, where both the accumulated text and the delta stream pick it up.
        const separated =
          this.interrupted && this.text.length > 0 && !this.text.endsWith('\n')
            ? `\n\n${event.text}`
            : event.text;
        this.interrupted = false;
        this.text += separated;
        this.emit({
          type: 'message.delta',
          roomId: this.roomId,
          messageId: this.messageId,
          text: separated,
        });
        return;
      }
      case 'tool':
      case 'file':
        this.interrupted = true;
        this.activity.push(event);
        this.activityEvent(event);
        return;
      case 'done':
        // The runtime's own final text is authoritative; streamed deltas can be partial.
        if (event.text) this.text = event.text;
        this.activityEvent(event);
        return;
      case 'error':
        this.activityEvent(event);
        return;
    }
  }

  /** A sink suitable for handing straight to `AgentAdapter.run`. */
  get sink(): (event: TurnEvent) => void {
    return (event) => this.push(event);
  }

  private activityEvent(event: TurnEvent): void {
    this.emit({ type: 'turn.activity', roomId: this.roomId, turnId: this.turnId, event });
  }
}
