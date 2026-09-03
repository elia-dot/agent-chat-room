import type { Participant, Room, TurnRecord } from '@agent-chat-room/core';
import { useState } from 'react';

import type { ChangedFiles } from '../api/client.js';
import { basename, duration, initials, runtimeClasses, stateLabel } from '../lib/format.js';
import { DiffViewer } from './DiffViewer.js';

export interface RightPanelProps {
  room: Room;
  participants: Participant[];
  turns: TurnRecord[];
  files: ChangedFiles | null;
  diff: { messageId: string; text: string; loading: boolean } | null;
  busy: boolean;
  onCloseDiff: () => void;
  onPause: () => void;
  onContinue: () => void;
  onStop: () => void;
  onCloseRoom: () => void;
  onRaiseRounds: (rounds: number) => void;
}

/**
 * PLAN.md section 5.4, minus the M3 actions.
 *
 * Commit / Open PR / Export markdown, the role dropdown and the model picker are all M3,
 * so the roster here is read-only. "Raise the round limit" is the exception: without it a
 * room that used up its rounds dead-ends in the browser, and the engine's own message says
 * to raise it – so end-to-end-from-the-browser requires it.
 */
export function RightPanel(props: RightPanelProps): React.ReactElement {
  const { room, participants, turns, files, diff } = props;

  if (diff) {
    return (
      <Panel>
        <div className="flex items-center justify-between px-3 py-2">
          <h2 className="text-xs font-semibold tracking-widest text-zinc-500 uppercase">Diff</h2>
          <button
            type="button"
            onClick={props.onCloseDiff}
            className="text-xs text-zinc-500 hover:underline"
          >
            back
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <DiffViewer diff={diff.text} loading={diff.loading} />
        </div>
      </Panel>
    );
  }

  return (
    <Panel>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        <Section title="Room">
          <Row label="repo" value={room.repoRoot} mono />
          <Row label="branch" value={room.roomBranch} mono />
          {room.worktreePath && <Row label="worktree" value={room.worktreePath} mono />}
          <Row label="base" value={room.baseSha?.slice(0, 8) ?? '–'} mono />
          <Row label="mode" value={room.mode} />
          <Row label="round" value={`${room.round}/${room.maxRounds}`} />
          <Row label="state" value={stateLabel(room.state, room.paused)} />
        </Section>

        <Section title="Participants">
          <ul className="space-y-1.5">
            {participants.map((p) => (
              <li key={p.id} className="flex items-center gap-2 text-xs">
                <span
                  className={`flex size-5 items-center justify-center rounded text-[9px] font-semibold ring-1 ring-inset ${runtimeClasses(p.runtime)}`}
                >
                  {initials(p.runtime)}
                </span>
                <span className="flex-1 truncate">{p.runtime}</span>
                <Tag>{p.role}</Tag>
                <Tag>{p.permission}</Tag>
              </li>
            ))}
            <li className="flex items-center gap-2 text-xs">
              <span
                className={`flex size-5 items-center justify-center rounded text-[9px] font-semibold ring-1 ring-inset ${runtimeClasses('you')}`}
              >
                YO
              </span>
              <span className="flex-1">you</span>
              <Tag>owner</Tag>
            </li>
          </ul>
        </Section>

        <Section title="Changed files">
          {files === null ? (
            <p className="text-xs text-zinc-500">loading…</p>
          ) : files.changed.length === 0 ? (
            <p className="text-xs text-zinc-500">Nothing changed yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {files.changed.map((path) => (
                <li key={path} className="truncate font-mono text-[11px]" title={path}>
                  {basename(path)}
                  <span className="ml-1 text-zinc-400">
                    {path.slice(0, path.length - basename(path).length)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Usage turns={turns} />
      </div>

      <RoomActions {...props} />
    </Panel>
  );
}

function Usage({ turns }: { turns: TurnRecord[] }): React.ReactElement {
  const finished = turns.filter((t) => t.endedAt);
  const wall = finished.reduce(
    (ms, t) => ms + (Date.parse(t.endedAt ?? '') - Date.parse(t.startedAt) || 0),
    0,
  );
  const tokens = turns.reduce((sum, t) => sum + (t.usage?.totalTokens ?? 0), 0);
  return (
    <Section title="Usage">
      <Row label="turns" value={String(turns.length)} />
      <Row label="wall time" value={duration(wall)} />
      {/* Not every runtime reports usage, so a zero here means "not reported", not "free". */}
      <Row label="tokens" value={tokens > 0 ? tokens.toLocaleString() : 'not reported'} />
    </Section>
  );
}

function RoomActions(props: RightPanelProps): React.ReactElement {
  const { room, busy } = props;
  const [rounds, setRounds] = useState(room.maxRounds + 2);
  const running = room.state === 'running' || room.state === 'waiting-reviews';
  const exhausted = room.round >= room.maxRounds && room.state !== 'approved';

  return (
    <div className="space-y-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex gap-2">
        {running ? (
          <Action onClick={props.onPause} disabled={busy}>
            Pause
          </Action>
        ) : (
          <Action
            onClick={props.onContinue}
            disabled={busy || room.closedAt !== null || room.state === 'approved'}
          >
            Continue
          </Action>
        )}
        <Action onClick={props.onStop} disabled={busy || !running}>
          Stop
        </Action>
      </div>

      {exhausted && (
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={room.round + 1}
            max={50}
            value={rounds}
            onChange={(e) => setRounds(Number(e.target.value))}
            className="w-16 rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          />
          <Action onClick={() => props.onRaiseRounds(rounds)} disabled={busy}>
            Raise round limit
          </Action>
        </div>
      )}

      <Action onClick={props.onCloseRoom} disabled={busy || room.closedAt !== null}>
        {room.closedAt ? 'Closed' : 'Close room (removes the worktree)'}
      </Action>
      {/* Commit, Open PR and Export markdown are M3 (PLAN.md section 6). */}
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
      {children}
    </aside>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section>
      <h2 className="mb-1.5 text-xs font-semibold tracking-widest text-zinc-500 uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-16 shrink-0 text-zinc-500">{label}</span>
      <span className={`min-w-0 flex-1 truncate ${mono ? 'font-mono' : ''}`} title={value}>
        {value}
      </span>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <span className="rounded bg-zinc-200 px-1.5 py-px text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
      {children}
    </span>
  );
}

function Action({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-xs font-medium hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
    >
      {children}
    </button>
  );
}
