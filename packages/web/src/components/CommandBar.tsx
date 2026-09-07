import type { Participant, Room } from '@agent-chat-room/core';

import type { ConnectionState } from '../api/socket.js';
import type { AgentTint } from '../lib/format.js';
import { basename, initials, tintOf } from '../lib/format.js';
import { StatePill } from './StatusDot.js';

export interface LiveTurn {
  /** Runtime taking the turn right now. */
  author: string;
  /** What it is doing, in the room's words: `writing`, `reviewing`. */
  action: string;
  /** Elapsed, already formatted as `m:ss`. */
  elapsed: string;
}

export interface CommandBarProps {
  room: Room | null;
  participants: Participant[];
  tints: Record<string, AgentTint>;
  roomCount: number;
  connection: ConnectionState;
  live: LiveTurn | null;
  dark: boolean;
  onRooms: () => void;
  onRoomOverlay: () => void;
  onActions: () => void;
  onToggleTheme: () => void;
}

/**
 * The single command bar the design collapses the old three-column chrome into.
 *
 * Everything that was permanent furniture – the rooms rail, the room facts, the roster,
 * seven action buttons – is now either in this 46px strip or one keystroke behind it. The
 * transcript gets the rest of the window, which is the point: this is a tool for reading
 * a long conversation, and the conversation was previously the narrowest column on screen.
 */
export function CommandBar(props: CommandBarProps): React.ReactElement {
  const { room, participants, tints, live } = props;
  const connected = props.connection === 'open';

  return (
    // `overflow-hidden` because everything but the room title is `shrink-0`: past a certain
    // width the row has nothing left to give and used to spill out of the 46px strip. The
    // pieces that drop out at narrow widths below are the ones with another route to them
    // (⌘K, ⌥R, ⌥A) or that repeat what the transcript already shows.
    <header className="flex h-[46px] shrink-0 items-center gap-3.5 overflow-hidden border-b border-line bg-surface px-3.5">
      <div className="flex shrink-0 items-center gap-2">
        <span
          title={connected ? 'connected' : props.connection}
          className={`size-[9px] rounded-[2px] ${connected ? 'bg-approve' : 'bg-error acr-pulse'}`}
        />
        <span className="font-mono text-[12px] font-medium tracking-[0.16em]">ACR</span>
      </div>

      <button
        type="button"
        onClick={props.onRooms}
        className="shrink-0 rounded border border-line bg-raised px-2 py-1 font-mono text-[11px] text-ink-dim hover:border-line-strong"
      >
        rooms <span className="text-ink-faint">{props.roomCount}</span>{' '}
        <span className="hidden text-ink-faint sm:inline">⌘K</span>
      </button>

      {room && (
        <>
          <span className="h-5 w-px shrink-0 bg-line" />
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="truncate text-[14px] font-medium">{room.title}</span>
            <StatePill state={room.state} paused={room.paused} mode={room.mode} />
            <span className="hidden shrink-0 font-mono text-[11px] text-ink-faint lg:inline">
              {basename(room.repoRoot)} · {room.roomBranch}
            </span>
          </div>
        </>
      )}

      <span className="flex-1" />

      {live && (
        <div className="hidden shrink-0 items-center gap-2 rounded border border-line bg-raised px-2.5 py-1 font-mono text-[11px] sm:flex">
          <span
            className={`size-1.5 rounded-full acr-pulse ${tintOf(tints[live.author]).rule.replace('/40', '')}`}
          />
          <span className={tintOf(tints[live.author]).text}>{live.author}</span>
          <span className="text-ink-faint">{live.action}</span>
          <span className="text-ink tabular-nums">{live.elapsed}</span>
        </div>
      )}

      {participants.length > 0 && (
        <div className="hidden shrink-0 items-center md:flex">
          {participants.map((participant, index) => {
            const tint = tintOf(tints[participant.runtime]);
            return (
              <span
                key={participant.id}
                title={`${participant.runtime} · ${participant.role}`}
                className={`flex size-6 items-center justify-center rounded-[5px] border bg-raised font-mono text-[9px] ${tint.border} ${tint.text} ${index > 0 ? '-ml-[5px]' : ''}`}
              >
                {initials(participant.runtime)}
              </span>
            );
          })}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-1">
        {room && (
          <>
            <BarButton onClick={props.onRoomOverlay}>
              room <span className="hidden text-ink-faint sm:inline">⌥R</span>
            </BarButton>
            <BarButton onClick={props.onActions}>
              actions <span className="hidden text-ink-faint sm:inline">⌥A</span>
            </BarButton>
          </>
        )}
        <button
          type="button"
          onClick={props.onToggleTheme}
          title={props.dark ? 'switch to light' : 'switch to dark'}
          className="flex size-[26px] items-center justify-center rounded border border-line text-[11px] text-ink-dim hover:border-line-strong"
        >
          ◐
        </button>
      </div>
    </header>
  );
}

function BarButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-line px-2 py-1 font-mono text-[11px] text-ink-dim hover:border-line-strong hover:text-ink"
    >
      {children}
    </button>
  );
}
