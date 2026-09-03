import type { IncomingFrame } from '../state/roomStore.js';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface RoomSocketOptions {
  onFrame: (frame: IncomingFrame) => void;
  onState?: (state: ConnectionState) => void;
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

  constructor(private readonly opts: RoomSocketOptions) {}

  connect(): void {
    this.closedByUs = false;
    this.open();
  }

  /** Watch a room. Safe before the socket is open: the id is replayed on connect. */
  subscribe(roomId: string): void {
    if (this.roomId === roomId) return;
    if (this.roomId) this.send({ type: 'unsubscribe', roomId: this.roomId });
    this.roomId = roomId;
    this.send({ type: 'subscribe', roomId });
  }

  close(): void {
    this.closedByUs = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
    this.socket = undefined;
  }

  private open(): void {
    const url =
      this.opts.url ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`;
    this.opts.onState?.('connecting');

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.retryMs = FIRST_RETRY_MS;
      this.opts.onState?.('open');
      if (!this.roomId) return;
      this.send({ type: 'subscribe', roomId: this.roomId });
      // The server sends a fresh snapshot on subscribe, so a reconnect self-heals; this
      // hook is for anything the caller keeps outside the socket, like the changed files.
      if (this.everConnected) this.opts.onReconnect?.(this.roomId);
      this.everConnected = true;
    });

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      try {
        this.opts.onFrame(JSON.parse(event.data) as IncomingFrame);
      } catch {
        // A frame we cannot parse is a bug on the server, not a reason to drop the socket.
      }
    });

    socket.addEventListener('close', () => {
      this.opts.onState?.('closed');
      if (this.closedByUs) return;
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
