import type { Message, Participant, RoomState } from '../store/types.js';
import type { TurnEvent } from '../types.js';

/**
 * The event names in PLAN.md section 4.4, defined in the engine rather than in the server
 * so that M2's WebSocket is a pass-through: the CLI renderer and the future web client
 * consume one shape, and nothing has to be re-derived when the socket lands.
 */
export type EngineEvent =
  | { type: 'room.state'; roomId: string; state: RoomState; round: number }
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
      case 'text':
        if (event.text.length === 0) return;
        this.text += event.text;
        this.emit({
          type: 'message.delta',
          roomId: this.roomId,
          messageId: this.messageId,
          text: event.text,
        });
        return;
      case 'tool':
      case 'file':
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
