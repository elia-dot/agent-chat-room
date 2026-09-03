import type { Room } from '@agent-chat-room/core';
import { useMemo, useState } from 'react';

import { basename, relativeTime } from '../lib/format.js';
import { StatusDot } from './StatusDot.js';

export interface RoomsSidebarProps {
  rooms: Room[];
  selectedId: string | null;
  unread: Record<string, number>;
  onSelect: (id: string) => void;
  onNewRoom: () => void;
  onDoctor: () => void;
  connection: 'connecting' | 'open' | 'closed';
}

/** PLAN.md section 5.1: the rooms list, with a status dot, an unread badge and a repo filter. */
export function RoomsSidebar({
  rooms,
  selectedId,
  unread,
  onSelect,
  onNewRoom,
  onDoctor,
  connection,
}: RoomsSidebarProps): React.ReactElement {
  const [repo, setRepo] = useState<string>('');
  const [showClosed, setShowClosed] = useState(false);

  const repos = useMemo(
    () => [...new Set(rooms.map((r) => r.repoRoot))].sort((a, b) => a.localeCompare(b)),
    [rooms],
  );
  const visible = rooms.filter(
    (r) => (!repo || r.repoRoot === repo) && (showClosed || !r.closedAt),
  );

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between px-3 py-3">
        <h1 className="text-xs font-semibold tracking-widest text-zinc-500 uppercase">Rooms</h1>
        <span
          title={`socket ${connection}`}
          className={`size-1.5 rounded-full ${
            connection === 'open'
              ? 'bg-emerald-500'
              : connection === 'connecting'
                ? 'bg-amber-500'
                : 'bg-rose-500'
          }`}
        />
      </div>

      {repos.length > 1 && (
        <div className="px-3 pb-2">
          <select
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">all repos</option>
            {repos.map((path) => (
              <option key={path} value={path}>
                {basename(path)}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 && (
          <p className="px-3 py-6 text-xs text-zinc-500">
            No rooms yet. Start one with <b>New room</b>.
          </p>
        )}
        <ul>
          {visible.map((room) => (
            <li key={room.id}>
              <button
                type="button"
                onClick={() => onSelect(room.id)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                  room.id === selectedId
                    ? 'bg-zinc-200 dark:bg-zinc-800'
                    : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'
                }`}
              >
                <StatusDot state={room.state} paused={room.paused} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{room.title}</span>
                  <span className="block truncate text-[11px] text-zinc-500">
                    {basename(room.repoRoot)} · {relativeTime(room.updatedAt)}
                  </span>
                </span>
                {(unread[room.id] ?? 0) > 0 && room.id !== selectedId && (
                  <span className="rounded-full bg-sky-600 px-1.5 text-[10px] leading-4 font-medium text-white">
                    {unread[room.id]}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-1 border-t border-zinc-200 p-2 dark:border-zinc-800">
        <button
          type="button"
          onClick={onNewRoom}
          className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          + New room
        </button>
        <div className="flex items-center justify-between px-1">
          <button
            type="button"
            onClick={() => setShowClosed((v) => !v)}
            className="text-[11px] text-zinc-500 hover:underline"
          >
            {showClosed ? 'hide closed' : 'show closed'}
          </button>
          <button
            type="button"
            onClick={onDoctor}
            className="text-[11px] text-zinc-500 hover:underline"
          >
            doctor
          </button>
        </div>
      </div>
    </aside>
  );
}
