import type {
  Detection,
  ModelCatalog,
  Participant,
  Role,
  Room,
  TurnRecord,
} from '@agent-chat-room/core';
import { useState } from 'react';

import type { ChangedFiles } from '../api/client.js';
import { api } from '../api/client.js';
import { basename, duration, initials, runtimeClasses, stateLabel } from '../lib/format.js';
import { AdditionalDirsEditor } from './AdditionalDirsEditor.js';
import { DiffViewer } from './DiffViewer.js';
import { ModelSelect } from './ModelSelect.js';

export interface RightPanelProps {
  room: Room;
  participants: Participant[];
  turns: TurnRecord[];
  files: ChangedFiles | null;
  diff: { messageId: string; text: string; loading: boolean } | null;
  busy: boolean;
  /** `gh` detection from `GET /api/runtimes`; null until it has been fetched. */
  gh: Detection | null;
  /** Model catalogs from `GET /api/runtimes/models`, keyed by runtime. Empty until fetched. */
  catalogs: Record<string, ModelCatalog>;
  onCloseDiff: () => void;
  onPause: () => void;
  onContinue: () => void;
  onStop: () => void;
  onCloseRoom: () => void;
  onPurgeRoom: () => void;
  onRaiseRounds: (rounds: number) => void;
  onSetAdditionalDirs: (paths: string[]) => void;
  onSetParticipant: (runtime: string, patch: { role?: Role; model?: string }) => void;
  onCommit: () => void;
  onOpenPr: (remote: string) => void;
  onPromote: () => void;
}

/** PLAN.md section 5.4: participants with a role dropdown, a model picker, and the actions. */
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
          <DiffViewer
            diff={diff.text}
            loading={diff.loading}
            basePath={room.worktreePath ?? room.repoRoot}
          />
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
          <Row label="state" value={stateLabel(room.state, room.paused, room.mode)} />
          {room.prUrl && (
            <div className="flex gap-2 text-xs">
              <span className="w-16 shrink-0 text-zinc-500">pr</span>
              <a
                href={room.prUrl}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate text-sky-600 hover:underline dark:text-sky-400"
              >
                {room.prUrl}
              </a>
            </div>
          )}
        </Section>

        <Section title="Participants">
          <ul className="space-y-2">
            {participants.map((p) => (
              <ParticipantRow
                key={p.id}
                participant={p}
                room={room}
                busy={props.busy}
                catalog={props.catalogs[p.runtime]}
                onSet={props.onSetParticipant}
              />
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

        <AdditionalFolders
          key={`${room.id}:${room.additionalDirs.join('\0')}`}
          room={room}
          busy={props.busy}
          onSave={props.onSetAdditionalDirs}
        />

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

function AdditionalFolders({
  room,
  busy,
  onSave,
}: {
  room: Room;
  busy: boolean;
  onSave: (paths: string[]) => void;
}): React.ReactElement {
  const [paths, setPaths] = useState(room.additionalDirs);

  const running = room.state === 'running' || room.state === 'waiting-reviews';
  const locked = busy || running || room.closedAt !== null;
  const changed =
    paths.length !== room.additionalDirs.length ||
    paths.some((path, index) => path !== room.additionalDirs[index]);

  return (
    <Section title="Additional folders">
      <AdditionalDirsEditor value={paths} onChange={setPaths} disabled={locked} />
      {paths.length === 0 && (
        <p className="mt-1 text-[11px] text-zinc-500">Only the room repository is accessible.</p>
      )}
      <button
        type="button"
        disabled={locked || !changed}
        onClick={() => onSave(paths)}
        className="mt-1.5 rounded border border-zinc-300 px-2 py-1 text-xs disabled:opacity-40 dark:border-zinc-700"
      >
        Save folder access
      </button>
    </Section>
  );
}

const ROLES_FOR: Record<Room['mode'], Role[]> = {
  'build-review': ['worker', 'reviewer'],
  brainstorm: ['reviewer', 'moderator'],
};

/**
 * One roster row, editable.
 *
 * Both controls are disabled while a turn is in flight: the permission a child was spawned
 * with is baked into that process, so the engine refuses a swap mid-round and the UI should
 * say so before the request rather than after.
 */
function ParticipantRow({
  participant,
  room,
  busy,
  catalog,
  onSet,
}: {
  participant: Participant;
  room: Room;
  busy: boolean;
  catalog: ModelCatalog | undefined;
  onSet: (runtime: string, patch: { role?: Role; model?: string }) => void;
}): React.ReactElement {
  const [model, setModel] = useState(participant.model ?? '');
  const running = room.state === 'running' || room.state === 'waiting-reviews';
  const locked = busy || running || room.closedAt !== null;

  return (
    <li className="space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <span
          className={`flex size-5 items-center justify-center rounded text-[9px] font-semibold ring-1 ring-inset ${runtimeClasses(participant.runtime)}`}
        >
          {initials(participant.runtime)}
        </span>
        <span className="flex-1 truncate">{participant.runtime}</span>
        <select
          value={participant.role}
          disabled={locked}
          aria-label={`${participant.runtime} role`}
          onChange={(e) => onSet(participant.runtime, { role: e.target.value as Role })}
          className="rounded border border-zinc-300 bg-white px-1 py-px text-[10px] disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
        >
          {roleOptions(room.mode, participant.role).map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
        <Tag>{participant.permission}</Tag>
      </div>
      <div className="flex items-center gap-1 pl-7">
        <ModelSelect
          runtime={participant.runtime}
          value={model}
          catalog={catalog}
          disabled={locked}
          className="flex-1"
          onChange={setModel}
          onCommit={(next) => {
            if (next !== (participant.model ?? '')) onSet(participant.runtime, { model: next });
          }}
        />
      </div>
    </li>
  );
}

/** The current role is always offered, even when the mode would not normally allow it. */
function roleOptions(mode: Room['mode'], current: Role): Role[] {
  const allowed = ROLES_FOR[mode] ?? ['worker', 'reviewer'];
  return allowed.includes(current) ? allowed : [current, ...allowed];
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
  const completedBrainstorm = room.mode === 'brainstorm' && room.round >= room.maxRounds;
  const exhausted =
    room.mode !== 'brainstorm' && room.round >= room.maxRounds && room.state !== 'approved';
  // The room ran in a worktree on `acr/<slug>`; with `--no-worktree` there is no room
  // branch to push, which is what makes the PR button meaningless there.
  const remote = room.roomBranch === room.baseBranch ? '' : 'origin';
  const ghReady = props.gh?.installed === true && props.gh.loggedIn !== false;

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
            disabled={
              busy || room.closedAt !== null || room.state === 'approved' || completedBrainstorm
            }
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

      {room.mode === 'brainstorm' ? (
        <Action onClick={props.onPromote} disabled={busy || running || room.closedAt !== null}>
          Promote the proposal into a build room
        </Action>
      ) : (
        <div className="flex gap-2">
          <Action onClick={props.onCommit} disabled={busy || running || room.closedAt !== null}>
            Commit
          </Action>
          {/* Absent, not merely disabled, when there is nothing to push to: a button that
              can never work is worse than no button. */}
          {remote && (
            <Action
              onClick={() => props.onOpenPr(remote)}
              disabled={busy || running || !ghReady || room.closedAt !== null}
              title={
                ghReady
                  ? `pushes ${room.roomBranch} to ${remote}, then opens a PR into ${room.baseBranch}`
                  : (props.gh?.note ?? 'checking for gh…')
              }
            >
              {room.prUrl ? 'PR opened' : 'Open PR'}
            </Action>
          )}
        </div>
      )}

      <a
        href={api.exportUrl(room.id)}
        download
        className="block rounded-md border border-zinc-300 px-2 py-1.5 text-center text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        Export markdown
      </a>

      <Action onClick={props.onCloseRoom} disabled={busy || room.closedAt !== null}>
        {room.closedAt ? 'Closed' : 'Close room (removes the worktree)'}
      </Action>

      <Action
        onClick={() => {
          const msg =
            'Purge all data for this room (worktree, diffs, turn logs, and history)? ' +
            'This cannot be undone.';
          if (window.confirm(msg)) {
            props.onPurgeRoom();
          }
        }}
        disabled={busy || running}
      >
        Purge Data
      </Action>
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
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...(title ? { title } : {})}
      className="flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-xs font-medium hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
    >
      {children}
    </button>
  );
}
