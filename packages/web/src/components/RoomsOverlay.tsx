import type { Room } from '@agent-chat-room/core';
import { useMemo, useState } from 'react';

import { basename, relativeTime, stateLabel } from '../lib/format.js';
import { Overlay } from './Overlay.js';
import { StatusDot } from './StatusDot.js';

export interface RoomsOverlayProps {
  rooms: Room[];
  selectedId: string | null;
  unread: Record<string, number>;
  onSelect: (id: string) => void;
  onNewRoom: () => void;
  onDoctor: () => void;
  onClose: () => void;
}

/**
 * The rooms list, as a palette rather than a rail.
 *
 * It was a permanent 256px column showing four rooms, which is a lot of window to spend on
 * something you touch when you switch tasks. Behind ⌘K it gets a filter box and the whole
 * height instead, and the transcript gets the space back.
 */
export function RoomsOverlay(props: RoomsOverlayProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [repo, setRepo] = useState('');
  const [showClosed, setShowClosed] = useState(false);

  const repos = useMemo(
    () => [...new Set(props.rooms.map((r) => r.repoRoot))].sort((a, b) => a.localeCompare(b)),
    [props.rooms],
  );

  const needle = query.trim().toLowerCase();
  const visible = props.rooms.filter(
    (room) =>
      (!repo || room.repoRoot === repo) &&
      (showClosed || !room.closedAt) &&
      (!needle ||
        room.title.toLowerCase().includes(needle) ||
        room.repoRoot.toLowerCase().includes(needle)),
  );

  return (
    <Overlay title="Rooms" hint="⌘K" side="left" onClose={props.onClose}>
      <div className="flex flex-col gap-2">
        {/* The list is the whole scroll container, so anything under it is a scroll away
            once you have more than a screenful of rooms – and starting a room is the one
            thing here that should never be. It sits beside the filter rather than above it
            so the box `autoFocus` lands in stays where the eye already is. */}
        <div className="flex gap-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter rooms…"
            aria-label="filter rooms"
            className="min-w-0 flex-1 rounded border border-line bg-surface px-2.5 py-1.5 text-[13px] placeholder:text-ink-faint focus:border-line-strong"
          />
          <button
            type="button"
            onClick={() => {
              props.onNewRoom();
              props.onClose();
            }}
            className="shrink-0 rounded bg-ink px-3 py-1.5 font-mono text-[12px] text-ground"
          >
            + new room
          </button>
        </div>
        {repos.length > 1 && (
          <select
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            aria-label="filter by repo"
            className="w-full rounded border border-line bg-surface px-2 py-1.5 font-mono text-[11.5px]"
          >
            <option value="">all repos</option>
            {repos.map((path) => (
              <option key={path} value={path}>
                {basename(path)}
              </option>
            ))}
          </select>
        )}
      </div>

      <ul className="mt-3 flex flex-col gap-0.5">
        {visible.length === 0 && (
          <li className="py-6 text-center font-mono text-[11.5px] text-ink-faint">
            {props.rooms.length === 0 ? 'no rooms yet' : 'nothing matches that filter'}
          </li>
        )}
        {visible.map((room) => (
          <li key={room.id}>
            <button
              type="button"
              onClick={() => {
                props.onSelect(room.id);
                props.onClose();
              }}
              className={`flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-left ${
                room.id === props.selectedId ? 'bg-raised' : 'hover:bg-surface'
              }`}
            >
              <StatusDot state={room.state} paused={room.paused} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] text-ink">{room.title}</span>
                <span className="block truncate font-mono text-[11px] text-ink-faint">
                  {basename(room.repoRoot)} · {stateLabel(room.state, room.paused, room.mode)} ·{' '}
                  {relativeTime(room.updatedAt)}
                </span>
              </span>
              {(props.unread[room.id] ?? 0) > 0 && room.id !== props.selectedId && (
                <span className="rounded-full bg-live px-1.5 font-mono text-[10px] leading-4 text-ground">
                  {props.unread[room.id]}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-4 border-t border-line pt-3">
        <div className="flex items-center justify-between px-1">
          <button
            type="button"
            onClick={() => setShowClosed((v) => !v)}
            className="font-mono text-[11px] text-ink-faint hover:text-ink"
          >
            {showClosed ? 'hide closed' : 'show closed'}
          </button>
          <button
            type="button"
            onClick={() => {
              props.onDoctor();
              props.onClose();
            }}
            className="font-mono text-[11px] text-ink-faint hover:text-ink"
          >
            doctor
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/**
 * The empty state: no room selected.
 *
 * The design keeps the state legend here, because the first thing a newcomer needs is not
 * a button, it is to know what the coloured dots in the rooms list are about to mean.
 */
export function EmptyState({
  onNewRoom,
  onRooms,
  hasRooms,
}: {
  onNewRoom: () => void;
  onRooms: () => void;
  hasRooms: boolean;
}): React.ReactElement {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <h2 className="font-mono text-[11px] tracking-[0.14em] text-ink-faint">NO ROOM SELECTED</h2>
        <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">
          You post a task. One agent builds on a branch of its own, the others review it, and they
          keep going until every reviewer approves, someone asks you a question, or you step in.
        </p>

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onNewRoom}
            className="rounded bg-ink px-3.5 py-2 font-mono text-[12px] text-ground"
          >
            new room
          </button>
          {hasRooms && (
            <button
              type="button"
              onClick={onRooms}
              className="rounded border border-line px-3.5 py-2 font-mono text-[12px] text-ink-dim hover:border-line-strong hover:text-ink"
            >
              open a room ⌘K
            </button>
          )}
        </div>

        <div className="mt-7 border-t border-line pt-4">
          <h3 className="font-mono text-[10px] tracking-[0.12em] text-ink-faint">STATES</h3>
          <ul className="mt-2.5 flex flex-col gap-1.5 font-mono text-[11.5px]">
            <Legend dot="bg-live" name="running">
              a turn is in flight
            </Legend>
            <Legend dot="bg-question" name="needs you">
              stopped for a question or a failure
            </Legend>
            <Legend dot="bg-approve" name="approved">
              every reviewer approved, and the round is committed
            </Legend>
            <Legend dot="bg-error" name="stopped">
              halted; inspect any remaining changes
            </Legend>
            <Legend dot="bg-ink-faint" name="idle">
              resumable, nothing running
            </Legend>
          </ul>
        </div>
        <a
          href="https://denly.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 inline-flex items-center gap-2 text-[12px] text-ink-dim hover:text-ink"
        >
          <img src="/denly-logo.png" alt="Denly logo" width={28} height={28} />
          <span>Built with the help of Denly</span>
        </a>
      </div>
    </div>
  );
}

function Legend({
  dot,
  name,
  children,
}: {
  dot: string;
  name: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <li className="flex items-center gap-2.5">
      <span className={`size-[7px] shrink-0 rounded-full ${dot}`} />
      <span className="w-20 shrink-0 text-ink-soft">{name}</span>
      <span className="text-ink-faint">{children}</span>
    </li>
  );
}
