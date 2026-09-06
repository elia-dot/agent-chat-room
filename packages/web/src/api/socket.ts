import type { IncomingFrame } from '../state/roomStore.js';

export type ConnectionState = 'connecting' | 'open' | 'closed';

/**
 * What the failure panel is allowed to say.
 *
 * Only things this browser actually observes. The design's artboard also shows worktree and
 * token status, but neither is knowable from here once the socket is down, and a panel that
 * invents a green tick is worse than one that admits the gap.
 */
export interface SocketDiagnostics {
  state: ConnectionState;
  /** The endpoint being dialled, so the panel can name the port that refused. */
  url: string;
  /** Consecutive failed connection attempts; 0 while connected. */
  attempt: number;
  /** Epoch ms of the next scheduled retry, or null when none is pending. */
  nextRetryAt: number | null;
  /** Epoch ms of the last frame received, which is how stale the transcript is. */
  lastFrameAt: number | null;
}

export interface RoomSocketOptions {
  onFrame: (frame: IncomingFrame) => void;
  onState?: (state: ConnectionState) => void;
  /** Called whenever the diagnostics change, so the failure panel can stay honest. */
  onDiagnostics?: (diagnostics: SocketDiagnostics) => void;
  /** Called after a reconnect, so the caller can re-fetch rather than trust its buffer. */
  onReconnect?: (roomId: string) => void;
  url?: string;
}

const FIRST_RETRY_MS = 300;
const MAX_RETRY_MS = 10_000;

/**
 * The room WebSocket, with reconnect.
 *
 * The reconnect story matters more than it looks: a delta that arrives while the socket is
 * down is gone for good, and a bubble that silently lost a paragraph is worse than one
 * that flickers. So a reconnect re-subscribes *and* tells the caller to re-fetch the
 * snapshot, which is authoritative.
 */
export class RoomSocket {
  private socket: WebSocket | undefined;
  private roomId: string | undefined;
  private retryMs = FIRST_RETRY_MS;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closedByUs = false;
  private everConnected = false;

  private state: ConnectionState = 'connecting';
  private attempt = 0;
  private nextRetryAt: number | null = null;
  private lastFrameAt: number | null = null;

  constructor(private readonly opts: RoomSocketOptions) {}

  connect(): void {
    this.closedByUs = false;
    this.open();
  }

  /**
   * Watch a room. Safe before the socket is open: the id is replayed on connect.
   *
   * Subscribing to the room already being watched is not a no-op: the server answers
   * every subscribe with a fresh snapshot, and a caller that has just emptied its store
   * needs exactly that.
   */
  subscribe(roomId: string): void {
    if (this.roomId && this.roomId !== roomId) {
      this.send({ type: 'unsubscribe', roomId: this.roomId });
    }
    this.roomId = roomId;
    this.send({ type: 'subscribe', roomId });
  }

  /** Skip the backoff. The human pressed "retry now", which is a better signal than a timer. */
  retryNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRetryAt = null;
    this.retryMs = FIRST_RETRY_MS;
    this.closedByUs = false;
    this.open();
  }

  diagnostics(): SocketDiagnostics {
    return {
      state: this.state,
      url: this.endpoint(),
      attempt: this.attempt,
      nextRetryAt: this.nextRetryAt,
      lastFrameAt: this.lastFrameAt,
    };
  }

  close(): void {
    this.closedByUs = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
    this.socket = undefined;
  }

  private endpoint(): string {
    return (
      this.opts.url ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`
    );
  }

  private report(state: ConnectionState): void {
    this.state = state;
    this.opts.onState?.(state);
    this.opts.onDiagnostics?.(this.diagnostics());
  }

  private open(): void {
    // One live socket at a time. "Retry now" can arrive while the previous attempt is
    // still handshaking; leaving that one alive would deliver every frame twice.
    const previous = this.socket;
    this.socket = undefined;
    previous?.close();

    this.report('connecting');

    const socket = new WebSocket(this.endpoint());
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (socket !== this.socket) return;
      this.retryMs = FIRST_RETRY_MS;
      this.attempt = 0;
      this.nextRetryAt = null;
      this.report('open');
      if (!this.roomId) return;
      this.send({ type: 'subscribe', roomId: this.roomId });
      // The server sends a fresh snapshot on subscribe, so a reconnect self-heals; this
      // hook is for anything the caller keeps outside the socket, like the changed files.
      if (this.everConnected) this.opts.onReconnect?.(this.roomId);
      this.everConnected = true;
    });

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      if (socket !== this.socket) return;
      try {
        const frame = JSON.parse(event.data) as IncomingFrame;
        this.lastFrameAt = Date.now();
        this.opts.onFrame(frame);
      } catch {
        // A frame we cannot parse is a bug on the server, not a reason to drop the socket.
      }
    });

    socket.addEventListener('close', () => {
      // A socket that was replaced must not schedule a retry of its own: only the current
      // one owns the timer, or a replaced socket would keep reopening after `close()`.
      if (socket !== this.socket) return;
      if (this.closedByUs) {
        this.report('closed');
        return;
      }
      this.attempt += 1;
      this.nextRetryAt = Date.now() + this.retryMs;
      this.report('closed');
      this.timer = setTimeout(() => this.open(), this.retryMs);
      // Backing off matters when the server is gone for good: without it a closed tab
      // would hammer localhost forever.
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    });

    socket.addEventListener('error', () => socket.close());
  }

  private send(frame: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }
}
