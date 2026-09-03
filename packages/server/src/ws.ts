import type { EngineEvent, Message, Participant, Room, TurnRecord } from '@agent-chat-room/core';
import type { FastifyInstance } from 'fastify';

import type { LiveTurn, RoomSupervisor } from './supervisor.js';

/** What a client sends. Anything else is answered with an error frame, not a disconnect. */
export type ClientFrame =
  | { type: 'subscribe'; roomId: string }
  | { type: 'unsubscribe'; roomId: string }
  | { type: 'ping' };

/**
 * What the server sends: one snapshot per subscription, then `EngineEvent`s verbatim.
 *
 * Forwarding the engine's own event type unchanged is the point of having defined it in
 * `core` – the terminal renderer and the browser consume one vocabulary, and there is no
 * server-side translation layer that can drift from the engine.
 */
export type ServerFrame =
  | {
      type: 'snapshot';
      roomId: string;
      room: Room;
      participants: Participant[];
      messages: Message[];
      turns: TurnRecord[];
      live: LiveTurn[];
      running: boolean;
    }
  | { type: 'error'; message: string; roomId?: string }
  | { type: 'pong' }
  | EngineEvent;

interface Socket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message' | 'close' | 'error', handler: (data?: unknown) => void): void;
}

export function websocketRoute(app: FastifyInstance, supervisor: RoomSupervisor): void {
  // A WebSocket handshake is not subject to CORS, so nothing in the browser stops a page
  // you have open from opening one. What stops it is `createApp`'s `onRequest` hook: the
  // upgrade is an ordinary request to `/api/ws`, so the origin check refuses it with a 403
  // before this handler ever runs. `security.test.ts` pins that.
  app.get('/api/ws', { websocket: true }, (socket: Socket, _request) => {
    const subscribed = new Set<string>();
    const send = (frame: ServerFrame): void => {
      try {
        socket.send(JSON.stringify(frame));
      } catch {
        // The socket went away between the check and the write. Nothing to do.
      }
    };

    const unsubscribe = supervisor.subscribe((event) => {
      if (subscribed.has(event.roomId)) send(event);
    });

    socket.on('message', (data: unknown) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(data)) as ClientFrame;
      } catch {
        send({ type: 'error', message: 'not JSON' });
        return;
      }

      switch (frame?.type) {
        case 'ping':
          send({ type: 'pong' });
          return;
        case 'unsubscribe':
          subscribed.delete(frame.roomId);
          return;
        case 'subscribe':
          void subscribe(frame.roomId);
          return;
        default:
          send({ type: 'error', message: `unknown frame type` });
      }
    });

    socket.on('close', () => {
      unsubscribe();
      subscribed.clear();
    });

    async function subscribe(roomId: string): Promise<void> {
      const room = supervisor.store.findRoom(roomId);
      if (!room) {
        send({ type: 'error', roomId, message: `no room matches "${roomId}"` });
        return;
      }
      try {
        await supervisor.open(room.id);
      } catch (err) {
        send({
          type: 'error',
          roomId: room.id,
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      // From here to the end of the function nothing awaits, so no event can land in the
      // gap between subscribing and snapshotting: reading the store and the live buffer is
      // synchronous, and Node will not interleave. That is what makes "snapshot first, then
      // events" a guarantee rather than a hope.
      subscribed.add(room.id);
      send({
        type: 'snapshot',
        roomId: room.id,
        room: supervisor.store.getRoom(room.id) ?? room,
        participants: supervisor.store.listParticipants(room.id),
        messages: supervisor.store.listMessages(room.id),
        turns: supervisor.store.listTurns(room.id),
        live: supervisor.live(room.id),
        running: supervisor.isRunning(room.id),
      });
    }
  });
}
