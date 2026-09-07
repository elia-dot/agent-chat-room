import type { Detection, ModelCatalog, Room } from '@agent-chat-room/core';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { ChangedFiles, CreateRoomRequest } from './api/client.js';
import { api } from './api/client.js';
import type { ConnectionState, SocketDiagnostics } from './api/socket.js';
import { RoomSocket } from './api/socket.js';
import { ActionsOverlay } from './components/ActionsOverlay.js';
import type { LiveTurn } from './components/CommandBar.js';
import { CommandBar } from './components/CommandBar.js';
import { Composer } from './components/Composer.js';
import { DisconnectedPanel } from './components/DisconnectedPanel.js';
import { DoctorPage } from './components/DoctorPage.js';
import { NewRoomDialog } from './components/NewRoomDialog.js';
import { RoomOverlay } from './components/RoomOverlay.js';
import { PhaseStrip, phasesOf } from './components/PhaseStrip.js';
import { ProposalCard } from './components/ProposalCard.js';
import { EmptyState, RoomsOverlay } from './components/RoomsOverlay.js';
import { RoundStrip } from './components/RoundStrip.js';
import { Transcript } from './components/Transcript.js';
import { agentTints, duration } from './lib/format.js';
import { byRuntime } from './lib/models.js';
import { reviewsIn, summariseRounds } from './lib/rounds.js';
import type { IncomingFrame } from './state/roomStore.js';
import { RoomStoreClient } from './state/roomStore.js';

interface DiffState {
  messageId: string;
  text: string;
  loading: boolean;
}

type Sheet = 'rooms' | 'room' | 'actions' | null;

export function App(): React.ReactElement {
  const store = useMemo(() => new RoomStoreClient(), []);
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const [rooms, setRooms] = useState<Room[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [diagnostics, setDiagnostics] = useState<SocketDiagnostics | null>(null);
  const [files, setFiles] = useState<ChangedFiles | null>(null);
  const [gh, setGh] = useState<Detection | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, ModelCatalog>>({});
  const [usableRuntimes, setUsableRuntimes] = useState<string[]>([]);
  const [diff, setDiff] = useState<DiffState | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [showNewRoom, setShowNewRoom] = useState(false);
  const [showDoctor, setShowDoctor] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Things worth saying that are not failures – an unrecognised model, so far. */
  const [notice, setNotice] = useState<string | null>(null);
  const [dark, setDark] = useState(prefersDark);
  /** Ticks once a second, only to keep the live turn's elapsed clock honest. */
  const [now, setNow] = useState(() => Date.now());

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
      // The rooms list and the round strip both move when a turn lands.
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
      onDiagnostics: setDiagnostics,
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
      .then((r) => {
        setGh(r.gh);
        // Only the ones that would actually run: offering a runtime that is not installed
        // in the roster's replace picker would just produce a failed turn.
        setUsableRuntimes(r.runtimes.filter((entry) => entry.usable).map((entry) => entry.id));
      })
      .catch(() => undefined);
    // The model picker's list. Cached server-side, so asking once here is enough, and a
    // failure just means the picker offers `default` and `Custom…`.
    void api
      .modelCatalogs()
      .then((r) => setCatalogs(byRuntime(r.catalogs)))
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

  const room = view.room;
  const live = view.pending.length > 0;
  const offline = connection !== 'open';

  // One clock for the whole app, held in state so nothing reads the wall clock while
  // rendering. It only needs to be accurate to the second while a turn is streaming; the
  // room's age moves slowly enough for half a minute.
  useEffect(() => {
    const counting = live || offline;
    const id = setInterval(() => setNow(Date.now()), counting ? 1000 : 30_000);
    return () => clearInterval(id);
  }, [live, offline]);

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
      setCollapsed(new Set());
      setUnread((u) => ({ ...u, [id]: 0 }));
      store.reset();
      socketRef.current?.subscribe(id);
      void refreshFiles(id);
    },
    [store, refreshFiles],
  );

  // The shortcuts the command bar advertises. A bar that prints ⌘K and does nothing when
  // you press it is worse than a bar with no hint at all.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const typing =
        event.target instanceof HTMLElement &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSheet((s) => (s === 'rooms' ? null : 'rooms'));
        return;
      }
      if (!event.altKey || typing) return;
      const key = event.key.toLowerCase();
      if (key === 'r' && room) {
        event.preventDefault();
        setSheet((s) => (s === 'room' ? null : 'room'));
      } else if (key === 'a' && room) {
        event.preventDefault();
        setSheet((s) => (s === 'actions' ? null : 'actions'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [room]);

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
    // A model the runtime has never reported is a warning, not a refusal – but it is the
    // one warning that predicts a dead first turn, so it is said out loud.
    setNotice(created.warnings.length > 0 ? created.warnings.join(' · ') : null);
    await refreshRooms();
    selectRoom(created.room.id);
  };

  const tints = useMemo(
    () => agentTints(view.participants.map((p) => p.runtime)),
    [view.participants],
  );

  // Every other room, offered behind `#` in the composer. Referencing the room you are in
  // would attach its own transcript to itself, so it is left out of the list.
  const referenceableRooms = useMemo(
    () =>
      rooms
        .filter((r) => r.id !== room?.id)
        .map((r) => ({ id: r.id, slug: r.slug, title: r.title })),
    [rooms, room?.id],
  );

  const rounds = useMemo(
    () => summariseRounds(view.messages, room?.round ?? 0, view.running || live),
    [view.messages, room?.round, view.running, live],
  );

  const brainstorm = room?.mode === 'brainstorm';
  // A brainstorm's output is the moderator's last message, which is what the engine's own
  // `proposal()` picks; deriving it here keeps the card in step with a streaming re-merge.
  const moderator = view.participants.find((p) => p.role === 'moderator');
  const proposal = brainstorm
    ? [...view.messages]
        .reverse()
        .find((m) => m.kind === 'agent' && m.author === moderator?.runtime)
    : undefined;
  const answers = view.messages.filter((m) => m.kind === 'agent' && m.round === 1).length;
  const reactions = view.messages.filter((m) => m.kind === 'agent' && m.round === 2).length;

  const reviewers = view.participants.filter((p) => p.role === 'reviewer').length;
  const pending = view.pending[0];
  const liveTurn: LiveTurn | null = pending
    ? {
        author: pending.author,
        action: pending.role === 'reviewer' ? 'reviewing' : 'writing',
        elapsed: elapsedOf(
          view.turns,
          view.participants.find((p) => p.runtime === pending.author)?.id,
          now,
        ),
      }
    : null;

  return (
    <div className="flex h-full flex-col bg-ground text-ink">
      <CommandBar
        room={showDoctor ? null : room}
        participants={showDoctor ? [] : view.participants}
        tints={tints}
        roomCount={rooms.filter((r) => !r.closedAt).length}
        connection={connection}
        live={liveTurn}
        dark={dark}
        onRooms={() => setSheet((s) => (s === 'rooms' ? null : 'rooms'))}
        onRoomOverlay={() => setSheet((s) => (s === 'room' ? null : 'room'))}
        onActions={() => setSheet((s) => (s === 'actions' ? null : 'actions'))}
        onToggleTheme={() => setDark((d) => !d)}
      />

      {room && !showDoctor && brainstorm && (
        <PhaseStrip
          phases={phasesOf(view.messages, room.round, view.running || live)}
          moderator={moderator?.runtime ?? null}
          age={duration(now - Date.parse(room.createdAt))}
          participants={view.participants.length}
          hasProposal={proposal !== undefined}
          onJumpToProposal={() =>
            document.getElementById('acr-proposal')?.scrollIntoView({ block: 'start' })
          }
        />
      )}

      {room && !showDoctor && !brainstorm && rounds.length > 0 && (
        <RoundStrip
          rounds={rounds}
          current={room.round}
          progress={reviewsIn(rounds, room.round, reviewers)}
          age={duration(now - Date.parse(room.createdAt))}
          collapsed={collapsed.size > 0}
          onJump={(round) =>
            document.getElementById(`round-${round}`)?.scrollIntoView({ block: 'start' })
          }
          onToggleCollapse={() =>
            setCollapsed((current) =>
              current.size > 0 ? new Set() : new Set(rounds.map((r) => r.round)),
            )
          }
        />
      )}

      {error && (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {notice && (
        <Banner tone="question" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        {showDoctor ? (
          <DoctorPage onClose={() => setShowDoctor(false)} />
        ) : room ? (
          <>
            <Transcript
              view={view}
              tints={tints}
              collapsed={collapsed}
              unit={brainstorm ? 'phase' : 'round'}
              {...(proposal ? { proposalId: proposal.id } : {})}
              renderProposal={(message) => (
                <ProposalCard
                  message={message}
                  {...(tints[message.author] ? { tint: tints[message.author] } : {})}
                  answers={answers}
                  reactions={reactions}
                  basePath={room.worktreePath ?? room.repoRoot}
                  busy={busy}
                  canPromote={!view.running && room.closedAt === null}
                  exportHref={api.exportUrl(room.id)}
                  onPromote={() =>
                    void act(async () => {
                      const created = await api.promote(room.id);
                      await refreshRooms();
                      selectRoom(created.room.id);
                    })
                  }
                  onAnotherRound={() =>
                    void act(() =>
                      api.say(
                        room.id,
                        'Another round of reactions, then re-merge the proposal.',
                        moderator?.runtime,
                      ),
                    )
                  }
                />
              )}
              onToggleRound={(round) =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(round)) next.delete(round);
                  else next.add(round);
                  return next;
                })
              }
              onOpenDiff={openDiff}
            />
            <Composer
              room={room}
              participants={view.participants}
              running={view.running}
              busy={busy}
              offline={offline}
              rooms={referenceableRooms}
              // Posting holds the loop on purpose (PLAN.md section 3: "You can interrupt any
              // time"), so continuing is a separate, deliberate click.
              onSend={(text, mention, extra) =>
                void act(() => api.say(room.id, text, mention ?? undefined, extra))
              }
              onUpload={(file) => api.uploadAttachment(room.id, file)}
              onPause={() => void act(() => api.pause(room.id))}
              onContinue={() => void act(() => api.start(room.id))}
              onStop={() => void act(() => api.stop(room.id))}
            />
          </>
        ) : (
          <EmptyState
            onNewRoom={() => setShowNewRoom(true)}
            onRooms={() => setSheet('rooms')}
            hasRooms={rooms.length > 0}
          />
        )}

        {/* The transcript stays visible behind this: the last state received is still true. */}
        {offline && diagnostics && (
          <DisconnectedPanel
            diagnostics={diagnostics}
            now={now}
            {...(liveTurn ? { context: `${liveTurn.author}'s turn may still be running` } : {})}
            onRetry={() => socketRef.current?.retryNow()}
          />
        )}
      </div>

      {sheet === 'rooms' && (
        <RoomsOverlay
          rooms={rooms}
          selectedId={selected}
          unread={unread}
          onSelect={selectRoom}
          onNewRoom={() => setShowNewRoom(true)}
          onDoctor={() => setShowDoctor(true)}
          onClose={() => setSheet(null)}
        />
      )}

      {room && (sheet === 'room' || diff) && (
        <RoomOverlay
          room={room}
          participants={view.participants}
          tints={tints}
          turns={view.turns}
          files={files}
          diff={diff}
          busy={busy}
          catalogs={catalogs}
          usableRuntimes={usableRuntimes}
          onClose={() => setSheet(null)}
          onCloseDiff={() => setDiff(null)}
          onSetAdditionalDirs={(additionalDirs) =>
            void act(async () => {
              const { room: updated } = await api.patchRoom(room.id, { additionalDirs });
              store.merge({ room: updated });
            })
          }
          onSetMaxTurnRetries={(maxTurnRetries) =>
            void act(async () => {
              const { room: updated } = await api.patchRoom(room.id, { maxTurnRetries });
              store.merge({ room: updated });
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
        />
      )}

      {room && sheet === 'actions' && (
        <ActionsOverlay
          room={room}
          busy={busy}
          gh={gh}
          onClose={() => setSheet(null)}
          onPause={() => void act(() => api.pause(room.id))}
          onContinue={() => void act(() => api.start(room.id))}
          onStop={() => void act(() => api.stop(room.id))}
          onCommit={() => void act(() => api.commit(room.id))}
          onMerge={() =>
            void act(async () => {
              const { room: updated } = await api.merge(room.id);
              store.merge({ room: updated });
            })
          }
          // The confirmation lives in the overlay, in the app's own voice, rather than in a
          // `window.confirm` the app cannot style or dismiss with its own Escape handling.
          onOpenPr={(remote) =>
            void act(async () => {
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
          onCloseRoom={() =>
            void act(async () => {
              await api.close(room.id);
              setSheet(null);
            })
          }
          onPurgeRoom={() =>
            void act(async () => {
              await api.purgeRoom(room.id);
              await refreshRooms();
              setSelected(null);
              setSheet(null);
            })
          }
        />
      )}

      {showNewRoom && <NewRoomDialog onClose={() => setShowNewRoom(false)} onCreate={createRoom} />}
    </div>
  );
}

function Banner({
  tone,
  children,
  onDismiss,
}: {
  tone: 'error' | 'question';
  children: React.ReactNode;
  onDismiss: () => void;
}): React.ReactElement {
  const style =
    tone === 'error'
      ? 'border-error-line bg-error-bg text-error'
      : 'border-question-line bg-question-bg text-question';
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex shrink-0 items-center gap-3 border-b px-4 py-1.5 text-[12px] ${style}`}
    >
      <span className="min-w-0 flex-1">{children}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded border border-current/40 px-2 py-0.5 font-mono text-[11px] hover:border-current"
      >
        dismiss
      </button>
    </div>
  );
}

/**
 * `m:ss` since the given participant's newest unfinished turn started.
 *
 * Which participant matters. In `waiting-reviews` several reviewer turns are open at once,
 * and this used to ignore its author argument and return the newest open turn whatever it
 * was, so the command bar paired one agent's name with another agent's clock. `TurnRecord`
 * keys on the participant id rather than the runtime, so the caller resolves it.
 *
 * Falls back to the newest open turn when nothing matches, which is the reconnect case: the
 * turn rows may not have arrived yet, and a slightly wrong clock beats a frozen `0:00`.
 */
function elapsedOf(
  turns: { participantId: string; startedAt: string; endedAt: string | null }[],
  participantId: string | undefined,
  now: number,
): string {
  const open = turns.filter((t) => !t.endedAt);
  const mine = open.filter((t) => t.participantId === participantId);
  const from = mine.length > 0 ? mine : open;
  const started = from.length > 0 ? Date.parse(from[from.length - 1]!.startedAt) : NaN;
  if (Number.isNaN(started)) return '0:00';
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function prefersDark(): boolean {
  const saved = localStorage.getItem('acr-theme');
  if (saved) return saved === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
