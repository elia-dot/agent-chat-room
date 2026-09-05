import type { Detection, Room } from '@agent-chat-room/core';

import { api } from '../api/client.js';
import { HoldToConfirm, TypeToConfirm } from './Confirm.js';
import { Divider, Overlay } from './Overlay.js';

export interface ActionsOverlayProps {
  room: Room;
  busy: boolean;
  /** `gh` detection from `GET /api/runtimes`; null until it has been fetched. */
  gh: Detection | null;
  onClose: () => void;
  onPause: () => void;
  onContinue: () => void;
  onStop: () => void;
  onCommit: () => void;
  onOpenPr: (remote: string) => void;
  onPromote: () => void;
  onCloseRoom: () => void;
  onPurgeRoom: () => void;
}

/**
 * The pressing half: everything that does something to the room.
 *
 * Split from the facts because the old panel put "Purge Data" two pixels below "Export
 * markdown" and gave them the same weight. Here the safe actions are a plain list and the
 * two that destroy work sit behind a labelled divider and a gesture, so reaching them is
 * deliberate.
 */
export function ActionsOverlay(props: ActionsOverlayProps): React.ReactElement {
  const { room, busy } = props;
  const running = room.state === 'running' || room.state === 'waiting-reviews';
  const completedBrainstorm = room.mode === 'brainstorm' && room.round >= room.maxRounds;
  const closed = room.closedAt !== null;
  // The room ran in a worktree on `acr/<slug>`; with `--no-worktree` there is no room
  // branch to push, which is what makes the PR button meaningless there.
  const remote = room.roomBranch === room.baseBranch ? '' : 'origin';
  const ghReady = props.gh?.installed === true && props.gh.loggedIn !== false;

  return (
    <Overlay title="Actions" hint="⌥A" onClose={props.onClose}>
      <div className="flex gap-2">
        {running ? (
          <Action onClick={props.onPause} disabled={busy}>
            pause
          </Action>
        ) : (
          <Action
            onClick={props.onContinue}
            disabled={busy || closed || room.state === 'approved' || completedBrainstorm}
            title={
              room.state === 'approved'
                ? 'this room is finished — @mention an agent in the composer to reopen it'
                : undefined
            }
          >
            continue
          </Action>
        )}
        <Action onClick={props.onStop} disabled={busy || !running}>
          stop
        </Action>
      </div>

      <Divider label="THE WORK" />
      <div className="mt-2 flex flex-col gap-2">
        {room.mode === 'brainstorm' ? (
          <Action onClick={props.onPromote} disabled={busy || running || closed}>
            promote the proposal into a build room
          </Action>
        ) : (
          <div className="flex gap-2">
            <Action onClick={props.onCommit} disabled={busy || running || closed}>
              commit
            </Action>
            {/* Absent, not merely disabled, when there is nothing to push to: a button that
                can never work is worse than no button. */}
            {remote && (
              <Action
                onClick={() => props.onOpenPr(remote)}
                disabled={busy || running || !ghReady || closed}
                title={
                  ghReady
                    ? `pushes ${room.roomBranch} to ${remote}, then opens a PR into ${room.baseBranch}`
                    : (props.gh?.note ?? 'checking for gh…')
                }
              >
                {room.prUrl ? 'pr opened' : 'open pr'}
              </Action>
            )}
          </div>
        )}
        <a
          href={api.exportUrl(room.id)}
          download
          className="rounded border border-line px-2.5 py-2 text-center font-mono text-[11.5px] text-ink-dim hover:border-line-strong hover:text-ink"
        >
          export markdown
        </a>
      </div>

      <Divider label="DESTRUCTIVE" tone="danger" />
      <div className="mt-2 flex flex-col gap-2 rounded-md border border-error-line bg-error-bg/40 p-3">
        <HoldToConfirm
          label={closed ? 'Room already closed' : 'Close room'}
          disabled={busy || closed}
          onConfirm={props.onCloseRoom}
        />
        <span className="h-px bg-error-line" />
        <TypeToConfirm
          label="Purge worktree & data"
          expect={room.title}
          disabled={busy || running}
          onConfirm={props.onPurgeRoom}
        />
        <p className="font-mono text-[10.5px] leading-relaxed text-error/80">
          Closing removes the worktree at {room.worktreePath ?? room.repoRoot} and keeps the branch.
          Purge also deletes the transcript, the stored diffs and the turn logs. Commits you have
          already pushed are unaffected.
        </p>
      </div>
    </Overlay>
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
      className="flex-1 rounded border border-line px-2.5 py-2 font-mono text-[11.5px] text-ink-dim hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
