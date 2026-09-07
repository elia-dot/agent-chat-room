import type { Detection, Room } from '@agent-chat-room/core';
import { useState } from 'react';

import { api } from '../api/client.js';
import { shortId } from '../lib/format.js';
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
  const [confirmPr, setConfirmPr] = useState(false);
  const running = room.state === 'running' || room.state === 'waiting-reviews';
  const completedBrainstorm = room.mode === 'brainstorm' && room.round >= room.maxRounds;
  const closed = room.closedAt !== null;
  const ghReady = props.gh?.installed === true && props.gh.loggedIn !== false;
  // The room ran in a worktree on `acr/<slug>`; with `--no-worktree` there is no room
  // branch to push, so there is nothing to open a PR from. The button used to be removed
  // in that case, which reads as a missing feature rather than as an answer – it stays
  // now, disabled, and says which of the two reasons is stopping it.
  const prBlocked =
    room.roomBranch === room.baseBranch
      ? `this room ran in your ${room.baseBranch} checkout rather than on a room branch, so there is no branch to open a PR from`
      : ghReady
        ? undefined
        : (props.gh?.note ?? 'checking for gh…');

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
                ? 'this room is finished – @mention an agent in the composer to reopen it'
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
            {/* Once there is a PR, the row's second slot is a fact, not a verb. It used to
                relabel itself "pr opened" and stay pressable, which is a control telling
                you something while still offering to act. */}
            {room.prUrl ? (
              <a
                href={room.prUrl}
                target="_blank"
                rel="noreferrer"
                className="flex-1 rounded border border-line px-2.5 py-2 text-center font-mono text-[11.5px] text-live hover:border-line-strong"
              >
                view pull request
              </a>
            ) : (
              <Action
                onClick={() => setConfirmPr(true)}
                disabled={busy || running || closed || Boolean(prBlocked)}
                title={
                  prBlocked ??
                  `pushes ${room.roomBranch} to origin, then opens a PR into ${room.baseBranch}`
                }
              >
                open pr
              </Action>
            )}
          </div>
        )}

        {/* The one outward-facing action gets the one confirmation, in the room's own
            voice. This was a `window.confirm`, which cannot be styled, ignores the app's
            Escape handling and is the only place the interface stopped sounding like
            itself. */}
        {confirmPr && (
          <div className="flex flex-col gap-2 rounded-md border border-question-line bg-question-bg p-3">
            <p className="text-[12.5px] leading-relaxed text-ink-soft">
              Push <span className="font-mono">{room.roomBranch}</span> to origin and open a pull
              request into <span className="font-mono">{room.baseBranch}</span>?
            </p>
            <p className="font-mono text-[10.5px] text-question">
              this is the only thing acr does that leaves your machine
            </p>
            <div className="flex gap-2">
              <Action onClick={() => setConfirmPr(false)}>cancel</Action>
              <Action
                onClick={() => {
                  setConfirmPr(false);
                  props.onOpenPr('origin');
                }}
                disabled={busy}
              >
                push & open pr
              </Action>
            </div>
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
        {/* The room id, not the title. Titles default to the first line of the task, so
            `expect` used to be a whole sentence – which is a copy-paste exercise, not a
            confirmation, and the quickest way through it is to select the placeholder. */}
        <TypeToConfirm
          label="Purge worktree & data"
          expect={shortId(room.id)}
          hint="type room id"
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
