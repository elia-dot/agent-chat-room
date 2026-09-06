import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionState } from '../src/api/socket.js';
import { RoomSocket } from '../src/api/socket.js';

/**
 * A WebSocket that dials nothing.
 *
 * Only the four members `RoomSocket` touches, so the test pins the reconnect logic rather
 * than a browser implementation.
 */
class FakeSocket {
  static live: FakeSocket[] = [];
  private readonly listeners = new Map<string, (() => void)[]>();
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.live.push(this);
  }

  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fire('close');
  }

  /** Drive the socket from the outside, the way a browser would. */
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }

  send(): void {}
}

const original = globalThis.WebSocket;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.live = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as { WebSocket: unknown }).WebSocket = original;
});

function socket(): { room: RoomSocket; states: ConnectionState[] } {
  const states: ConnectionState[] = [];
  const room = new RoomSocket({
    url: 'ws://127.0.0.1:0/api/ws',
    onFrame: () => {},
    onState: (state) => states.push(state),
  });
  return { room, states };
}

describe('RoomSocket.close', () => {
  it('reports the close it performed, instead of going on claiming `open`', () => {
    const { room, states } = socket();
    room.connect();
    FakeSocket.live[0]!.fire('open');
    expect(room.diagnostics().state).toBe('open');

    room.close();

    // The bug this pins: `close()` clears `this.socket` before the socket's own `close`
    // listener runs, so the listener's ownership check bails and never reported anything.
    // The state stayed `open` for the rest of the page's life, and the failure panel with
    // it.
    expect(room.diagnostics().state).toBe('closed');
    expect(states).toEqual(['connecting', 'open', 'closed']);
    expect(FakeSocket.live[0]!.closed).toBe(true);
  });

  it('schedules no reconnect, and lets none fire afterwards', () => {
    const { room } = socket();
    room.connect();
    FakeSocket.live[0]!.fire('open');

    room.close();
    expect(room.diagnostics().nextRetryAt).toBeNull();

    // Nothing may dial again: an explicit close is the caller saying they are done, and a
    // timer that outlived it would reopen the socket behind their back.
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.live).toHaveLength(1);
  });

  it('is idempotent, and a late event from the dead socket changes nothing', () => {
    const { room, states } = socket();
    room.connect();
    FakeSocket.live[0]!.fire('open');
    room.close();

    room.close();
    // A real browser delivers `close` asynchronously, so the event can arrive after the
    // caller has moved on. It must not be mistaken for a dropped connection.
    FakeSocket.live[0]!.fire('close');
    vi.advanceTimersByTime(60_000);

    expect(states).toEqual(['connecting', 'open', 'closed']);
    expect(room.diagnostics().nextRetryAt).toBeNull();
    expect(FakeSocket.live).toHaveLength(1);
  });

  it('still reconnects when the close was the server dropping us', () => {
    const { room, states } = socket();
    room.connect();
    FakeSocket.live[0]!.fire('open');

    // Not our close: the socket died on its own, which is exactly what the backoff is for.
    FakeSocket.live[0]!.fire('close');

    expect(states).toEqual(['connecting', 'open', 'closed']);
    expect(room.diagnostics().nextRetryAt).not.toBeNull();
    expect(room.diagnostics().attempt).toBe(1);

    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.live.length).toBeGreaterThan(1);
  });
});
