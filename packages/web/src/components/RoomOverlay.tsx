import type {
  AdditionalDir,
  ModelCatalog,
  Participant,
  Role,
  Room,
  TurnRecord,
} from '@agent-chat-room/core';
import { useState } from 'react';

import type { ChangedFiles } from '../api/client.js';
import type { AgentTint } from '../lib/format.js';
import { basename, duration, initials, stateLabel, tintOf } from '../lib/format.js';
import { AdditionalDirsEditor } from './AdditionalDirsEditor.js';
import { DiffViewer } from './DiffViewer.js';
import { ModelSelect } from './ModelSelect.js';
import { Divider, Fact, Overlay } from './Overlay.js';

export interface RoomOverlayProps {
  room: Room;
  participants: Participant[];
  tints: Record<string, AgentTint>;
  turns: TurnRecord[];
  files: ChangedFiles | null;
  diff: { messageId: string; text: string; loading: boolean } | null;
  busy: boolean;
  catalogs: Record<string, ModelCatalog>;
  onClose: () => void;
  onCloseDiff: () => void;
  onSetAdditionalDirs: (dirs: AdditionalDir[]) => void;
  onSetParticipant: (
    runtime: string,
    patch: { role?: Role; model?: string; runtime?: string },
  ) => void;
  /** Runtime ids this machine can actually run, for the roster's replace-runtime picker. */
  usableRuntimes: string[];
  onSetMaxTurnRetries: (value: number) => void;
}

/**
 * The reading half of the old right panel: what this room is, who is in it, what changed.
 *
 * The design's rule is that reading and pressing are different activities and should not
 * share a surface. Nothing in here does anything to the room except the two roster
 * controls, which are edits to who the room is rather than commands to it.
 */
export function RoomOverlay(props: RoomOverlayProps): React.ReactElement {
  const { room, participants, turns, files, diff } = props;

  if (diff) {
    return (
      <Overlay title="Diff" onClose={props.onCloseDiff}>
        <DiffViewer
          diff={diff.text}
          loading={diff.loading}
          basePath={room.worktreePath ?? room.repoRoot}
        />
      </Overlay>
    );
  }

  return (
    <Overlay title="Room" hint="⌥R" onClose={props.onClose}>
      <section>
        <Fact label="repo" mono>
          {room.repoRoot}
        </Fact>
        <Fact label="branch" mono>
          {room.roomBranch}
        </Fact>
        {room.worktreePath && (
          <Fact label="worktree" mono>
            {room.worktreePath}
          </Fact>
        )}
        <Fact label="base" mono>
          {room.baseSha?.slice(0, 8) ?? '–'}
        </Fact>
        <Fact label="mode">{room.mode}</Fact>
        <Fact label="round">
          {room.mode === 'brainstorm' ? `${room.round} of ${room.maxRounds}` : room.round}
        </Fact>
        <Fact label="state">{stateLabel(room.state, room.paused, room.mode)}</Fact>
        {room.prUrl && (
          <Fact label="pr">
            <a
              href={room.prUrl}
              target="_blank"
              rel="noreferrer"
              className="text-live hover:underline"
            >
              {room.prUrl}
            </a>
          </Fact>
        )}
        {/* A room that writes to additional folders opens one pull request per repository,
            so the panel lists them all rather than only the room repo's. */}
        {room.additionalDirs
          .filter((dir) => dir.prUrl)
          .map((dir) => (
            <Fact key={dir.path} label="pr">
              <a
                href={dir.prUrl!}
                target="_blank"
                rel="noreferrer"
                className="text-live hover:underline"
                title={dir.path}
              >
                {dir.prUrl}
              </a>
            </Fact>
          ))}
      </section>

      <Divider label="ROSTER" />
      <ul className="mt-2 space-y-2.5">
        {participants.map((participant) => (
          <ParticipantRow
            key={participant.id}
            participant={participant}
            tint={props.tints[participant.runtime]}
            room={room}
            busy={props.busy}
            catalog={props.catalogs[participant.runtime]}
            usableRuntimes={props.usableRuntimes}
            taken={participants.map((p) => p.runtime)}
            onSet={props.onSetParticipant}
          />
        ))}
        <li className="flex items-center gap-2 text-[12px]">
          <span className="flex size-6 items-center justify-center rounded-[5px] border border-line-strong bg-raised font-mono text-[9px] text-ink-dim">
            YO
          </span>
          <span className="flex-1">you</span>
          <Tag>owner</Tag>
        </li>
      </ul>

      <Divider label="WHEN A TURN FAILS" />
      <RetryPolicy room={room} busy={props.busy} onSet={props.onSetMaxTurnRetries} />

      <Divider label="FOLDER ACCESS" />
      <AdditionalFolders
        key={`${room.id}:${room.additionalDirs.map((d) => `${d.path}:${d.access}`).join('\0')}`}
        room={room}
        busy={props.busy}
        onSave={props.onSetAdditionalDirs}
      />

      <Divider label="CHANGED FILES" />
      <div className="mt-2">
        {files === null ? (
          <p className="font-mono text-[11px] text-ink-faint">loading…</p>
        ) : files.changed.length === 0 ? (
          <p className="font-mono text-[11px] text-ink-faint">Nothing changed yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {files.changed.map((path) => (
              <li key={path} className="truncate font-mono text-[11px]" title={path}>
                <span className="text-ink-soft">{basename(path)}</span>{' '}
                <span className="text-ink-faint">
                  {path.slice(0, path.length - basename(path).length)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Divider label="USAGE" />
      <div className="mt-2">
        <Usage turns={turns} />
      </div>
    </Overlay>
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
    <>
      <Fact label="turns" mono>
        {turns.length}
      </Fact>
      <Fact label="wall time" mono>
        {duration(wall)}
      </Fact>
      {/* Not every runtime reports usage, so a zero here means "not reported", not "free". */}
      <Fact label="tokens" mono>
        {tokens > 0 ? tokens.toLocaleString() : 'not reported'}
      </Fact>
    </>
  );
}

function AdditionalFolders({
  room,
  busy,
  onSave,
}: {
  room: Room;
  busy: boolean;
  onSave: (dirs: AdditionalDir[]) => void;
}): React.ReactElement {
  const [dirs, setDirs] = useState(room.additionalDirs);

  const running = room.state === 'running' || room.state === 'waiting-reviews';
  const locked = busy || running || room.closedAt !== null;
  const changed =
    dirs.length !== room.additionalDirs.length ||
    dirs.some(
      (dir, index) =>
        dir.path !== room.additionalDirs[index]?.path ||
        dir.access !== room.additionalDirs[index]?.access,
    );

  return (
    <div className="mt-2">
      <AdditionalDirsEditor value={dirs} onChange={setDirs} disabled={locked} />
      {dirs.length === 0 && (
        <p className="mt-1 font-mono text-[11px] text-ink-faint">
          Only the room repository is accessible.
        </p>
      )}
      <button
        type="button"
        disabled={locked || !changed}
        onClick={() => onSave(dirs)}
        className="mt-2 rounded border border-line px-2 py-1 font-mono text-[11px] text-ink-dim hover:border-line-strong disabled:opacity-40"
      >
        save folder access
      </button>
    </div>
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
  tint,
  room,
  busy,
  catalog,
  usableRuntimes,
  taken,
  onSet,
}: {
  participant: Participant;
  tint: AgentTint | undefined;
  room: Room;
  busy: boolean;
  catalog: ModelCatalog | undefined;
  usableRuntimes: string[];
  taken: string[];
  onSet: (participantId: string, patch: { role?: Role; model?: string; runtime?: string }) => void;
}): React.ReactElement {
  const [model, setModel] = useState(participant.model ?? '');
  const running = room.state === 'running' || room.state === 'waiting-reviews';
  const locked = busy || running || room.closedAt !== null;
  const tone = tintOf(tint);

  return (
    <li className="space-y-1.5">
      <div className="flex items-center gap-2 text-[12px]">
        <span
          className={`flex size-6 items-center justify-center rounded-[5px] border bg-raised font-mono text-[9px] ${tone.border} ${tone.text}`}
        >
          {initials(participant.runtime)}
        </span>
        <select
          value={participant.runtime}
          disabled={locked}
          aria-label={`${participant.runtime} runtime`}
          onChange={(e) => onSet(participant.id, { runtime: e.target.value })}
          className={`min-w-0 flex-1 truncate rounded border border-transparent bg-transparent font-mono text-[12px] hover:border-line disabled:opacity-50 ${tone.text}`}
          title="Replace this runtime. The replacement starts a fresh session."
        >
          {runtimeOptions(participant.runtime, usableRuntimes, taken).map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <select
          value={participant.role}
          disabled={locked}
          aria-label={`${participant.runtime} role`}
          onChange={(e) => onSet(participant.id, { role: e.target.value as Role })}
          className="rounded border border-line bg-surface px-1 py-px font-mono text-[10px] disabled:opacity-50"
        >
          {roleOptions(room.mode, participant.role).map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
        <Tag>{participant.permission}</Tag>
      </div>
      <div className="pl-8">
        <ModelSelect
          runtime={participant.runtime}
          value={model}
          catalog={catalog}
          disabled={locked}
          className="w-full"
          onChange={setModel}
          onCommit={(next) => {
            if (next !== (participant.model ?? '')) onSet(participant.id, { model: next });
          }}
        />
      </div>
    </li>
  );
}

/**
 * What this slot may become: whatever this machine can run, minus the runtimes already in
 * the room, plus the incumbent so the select always shows its own value. A room cannot hold
 * the same runtime twice – two participants called `claude` would be indistinguishable in
 * the transcript and in an `@mention`.
 */
function runtimeOptions(current: string, usable: string[], taken: string[]): string[] {
  const others = new Set(taken.filter((id) => id !== current));
  return [current, ...usable.filter((id) => id !== current && !others.has(id))];
}

/**
 * The room's retry budget, editable while the room is open.
 *
 * Unlike the roster this stays enabled during a round: the engine re-reads the budget at
 * the top of every attempt, so raising it while a flaky turn is failing takes effect on
 * that very turn rather than the next room.
 */
function RetryPolicy({
  room,
  busy,
  onSet,
}: {
  room: Room;
  busy: boolean;
  onSet: (value: number) => void;
}): React.ReactElement {
  const value = room.maxTurnRetries;
  return (
    <label className="mt-2 flex items-center gap-2 text-[12px]">
      <select
        value={value}
        disabled={busy || room.closedAt !== null}
        aria-label="retries per failed turn"
        onChange={(e) => onSet(Number(e.target.value))}
        className="rounded border border-line bg-surface px-1 py-px font-mono text-[10px] disabled:opacity-50"
      >
        {[0, 1, 2, 3].map((n) => (
          <option key={n} value={n}>
            {n === 0 ? 'never retry' : `retry ${n}×`}
          </option>
        ))}
      </select>
      <span className="min-w-0 flex-1 font-mono text-[11px] text-ink-faint">
        {value > 0
          ? `a failed turn runs again up to ${value}× before the room asks you`
          : 'the first failure hands the room back to you'}
      </span>
    </label>
  );
}

/** The current role is always offered, even when the mode would not normally allow it. */
function roleOptions(mode: Room['mode'], current: Role): Role[] {
  const allowed = ROLES_FOR[mode] ?? ['worker', 'reviewer'];
  return allowed.includes(current) ? allowed : [current, ...allowed];
}

function Tag({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <span className="rounded bg-raised px-1.5 py-px font-mono text-[10px] text-ink-faint">
      {children}
    </span>
  );
}
