import type { Detection, Room } from '@agent-chat-room/core';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { ChangedFiles, CreateRoomRequest } from './api/client.js';
import { api } from './api/client.js';
import type { ConnectionState } from './api/socket.js';
import { RoomSocket } from './api/socket.js';
import { Composer } from './components/Composer.js';
import { DoctorPage } from './components/DoctorPage.js';
import { NewRoomDialog } from './components/NewRoomDialog.js';
import { RightPanel } from './components/RightPanel.js';
import { RoomsSidebar } from './components/RoomsSidebar.js';
import { StatusDot } from './components/StatusDot.js';
import { Transcript } from './components/Transcript.js';
import { stateLabel } from './lib/format.js';
import type { IncomingFrame } from './state/roomStore.js';
import { RoomStoreClient } from './state/roomStore.js';

interface DiffState {
  messageId: string;
  text: string;
  loading: boolean;
}

export function App(): React.ReactElement {
  const store = useMemo(() => new RoomStoreClient(), []);
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const [rooms, setRooms] = useState<Room[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [files, setFiles] = useState<ChangedFiles | null>(null);
  const [gh, setGh] = useState<Detection | null>(null);
  const [diff, setDiff] = useState<DiffState | null>(null);
  const [showNewRoom, setShowNewRoom] = useState(false);
  const [showDoctor, setShowDoctor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dark, setDark] = useState(prefersDark);

  const socketRef = useRef<RoomSocket | null>(null);
  const onFrameRef = useRef<(frame: IncomingFrame) => void>(() => undefined);
  const onReconnectRef = useRef<(roomId: string) => void>(() => undefined);

  const refreshRooms = useCallback(async (): Promise<void> => {
    setRooms(await api.rooms({ limit: 100 }));
  }, []);

  const refreshFiles = useCallback(async (roomId: string): Promise<void> => {
    setFiles(await api.files(roomId).catch(() => ({ changed: [], stat: '' })));
  }, []);

  // The handlers close over state that changes on every render; the socket must not be
  // rebuilt when they do, or a re-render would drop the stream every time a delta arrived.
  // So they live behind refs, refreshed after each commit and read at call time. This
  // effect is declared before the socket's, so the first frame always finds a handler.
  useEffect(() => {
    onFrameRef.current = (frame) => {
      store.apply(frame);
      if (frame.type !== 'message.done' && frame.type !== 'room.state') return;
      // The sidebar reads the room list, and a finished turn changes a room's state, its
      // round and its place in "most recently updated".
      void refreshRooms();
      if (frame.type === 'message.done' && frame.roomId !== selected) {
        setUnread((u) => ({ ...u, [frame.roomId]: (u[frame.roomId] ?? 0) + 1 }));
      }
      if (frame.type === 'room.state' && frame.roomId === selected) void refreshFiles(frame.roomId);
    };
    onReconnectRef.current = (roomId) => void refreshFiles(roomId);
  });

  useEffect(() => {
    const socket = new RoomSocket({
      onState: setConnection,
      onFrame: (frame) => onFrameRef.current(frame),
      onReconnect: (roomId) => onReconnectRef.current(roomId),
    });
    socketRef.current = socket;
    socket.connect();
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    void api
      .rooms({ limit: 100 })
      .then(setRooms)
      .catch((err: unknown) => setError(describe(err)));
    // Detection is cheap and never changes mid-session, so "Open PR" asks once rather than
    // on every render of the panel.
    void api
      .runtimes()
      .then((r) => setGh(r.gh))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('acr-theme', dark ? 'dark' : 'light');
  }, [dark]);

  // Tab title carries the count, so a backgrounded browser still tells you something.
  useEffect(() => {
    const waiting = rooms.filter((r) => !r.closedAt && r.state === 'needs-you').length;
    document.title = waiting > 0 ? `(${waiting}) agent chat room` : 'agent chat room';
  }, [rooms]);

  /**
   * Selecting a room is an event, not a synchronisation: clearing the old room's diff and
   * files belongs here rather than in an effect keyed on `selected`.
   */
  const selectRoom = useCallback(
    (id: string) => {
      setShowDoctor(false);
      setSelected(id);
      setDiff(null);
      setFiles(null);
      setUnread((u) => ({ ...u, [id]: 0 }));
      store.reset();
      socketRef.current?.subscribe(id);
      void refreshFiles(id);
    },
    [store, refreshFiles],
  );

  const room = view.room;

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refreshRooms();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const openDiff = (messageId: string): void => {
    if (!room) return;
    setDiff({ messageId, text: '', loading: true });
    void api
      .diff(room.id, messageId)
      .then((text) => setDiff({ messageId, text, loading: false }))
      .catch((err: unknown) => {
        setError(describe(err));
        setDiff(null);
      });
  };

  const createRoom = async (input: CreateRoomRequest): Promise<void> => {
    const created = await api.createRoom(input);
    setShowNewRoom(false);
    await refreshRooms();
    selectRoom(created.room.id);
  };

  return (
    <div className="flex h-full bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
      <RoomsSidebar
        rooms={rooms}
        selectedId={selected}
        unread={unread}
        connection={connection}
        onSelect={selectRoom}
        onNewRoom={() => setShowNewRoom(true)}
        onDoctor={() => setShowDoctor(true)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
          {room && !showDoctor ? (
            <>
              <StatusDot state={room.state} paused={room.paused} />
              <h2 className="min-w-0 flex-1 truncate font-medium"># {room.title}</h2>
              <span className="text-xs text-zinc-500">
                {stateLabel(room.state, room.paused, room.mode)} · round {room.round}/
                {room.maxRounds}
              </span>
            </>
          ) : (
            <h2 className="flex-1 font-medium">{showDoctor ? 'Doctor' : 'agent chat room'}</h2>
          )}
          <button
            type="button"
            onClick={() => setDark((d) => !d)}
            className="text-xs text-zinc-500 hover:underline"
          >
            {dark ? 'light' : 'dark'}
          </button>
        </header>

        {error && (
          <div className="flex items-center gap-2 bg-rose-500/10 px-4 py-1.5 text-xs text-rose-700 dark:text-rose-400">
            <span className="flex-1">{error}</span>
            <button type="button" onClick={() => setError(null)} className="hover:underline">
              dismiss
            </button>
          </div>
        )}

        {showDoctor ? (
          <DoctorPage onClose={() => setShowDoctor(false)} />
        ) : room ? (
          <>
            <Transcript view={view} onOpenDiff={openDiff} />
            <Composer
              room={room}
              participants={view.participants}
              running={view.running}
              busy={busy}
              // Posting holds the loop on purpose (PLAN.md section 3: "You can interrupt any
              // time"), so continuing is a separate, deliberate click.
              onSend={(text, mention) =>
                void act(() => api.say(room.id, text, mention ?? undefined))
              }
              onPause={() => void act(() => api.pause(room.id))}
              onContinue={() => void act(() => api.start(room.id))}
              onStop={() => void act(() => api.stop(room.id))}
            />
          </>
        ) : (
          <Empty onNewRoom={() => setShowNewRoom(true)} />
        )}
      </main>

      {room && !showDoctor && (
        <RightPanel
          room={room}
          participants={view.participants}
          turns={view.turns}
          files={files}
          diff={diff}
          busy={busy}
          gh={gh}
          onCloseDiff={() => setDiff(null)}
          onPause={() => void act(() => api.pause(room.id))}
          onContinue={() => void act(() => api.start(room.id))}
          onStop={() => void act(() => api.stop(room.id))}
          onCloseRoom={() => void act(() => api.close(room.id))}
          onRaiseRounds={(rounds) =>
            void act(async () => {
              await api.patchRoom(room.id, { maxRounds: rounds });
              await api.start(room.id);
            })
          }
          onSetParticipant={(runtime, patch) =>
            void act(async () => {
              const { participants } = await api.setParticipant(room.id, runtime, patch);
              // The engine also broadcasts `room.roster`, but only to a subscribed socket;
              // merging here keeps the panel honest if the socket is reconnecting.
              store.merge({ participants });
            })
          }
          onCommit={() => void act(() => api.commit(room.id))}
          onOpenPr={(remote) =>
            void act(async () => {
              if (
                !window.confirm(
                  `Push ${room.roomBranch} to ${remote} and open a pull request into ${room.baseBranch}?\n\nThis is the only thing acr does that leaves your machine.`,
                )
              ) {
                return;
              }
              const { room: updated } = await api.openPr(room.id, { remote });
              store.merge({ room: updated });
            })
          }
          onPromote={() =>
            void act(async () => {
              const created = await api.promote(room.id);
              await refreshRooms();
              selectRoom(created.room.id);
            })
          }
        />
      )}

      {showNewRoom && <NewRoomDialog onClose={() => setShowNewRoom(false)} onCreate={createRoom} />}
    </div>
  );
}

function Empty({ onNewRoom }: { onNewRoom: () => void }): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <p className="max-w-sm text-sm text-zinc-500">
        Pick a room on the left, or open a new one: you post a task, one agent builds, the others
        review, and they iterate until they agree or you step in.
      </p>
      <button
        type="button"
        onClick={onNewRoom}
        className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
      >
        New room
      </button>
    </div>
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function prefersDark(): boolean {
  const saved = localStorage.getItem('acr-theme');
  if (saved) return saved === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
