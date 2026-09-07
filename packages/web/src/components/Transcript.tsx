import type { Message } from '@agent-chat-room/core';
import { useEffect, useRef } from 'react';

import type { AgentTint } from '../lib/format.js';
import { initials, tintOf } from '../lib/format.js';
import type { RoomView } from '../state/roomStore.js';
import { MessageBubble, PersistedMessage } from './MessageBubble.js';
import { RoundDivider, SystemLine } from './SystemLine.js';
import { VerdictPill } from './VerdictPill.js';

export interface TranscriptProps {
  view: RoomView;
  tints: Record<string, AgentTint>;
  /** Rounds the human has folded away. */
  collapsed: ReadonlySet<number>;
  /** A brainstorm counts phases; the divider says so. */
  unit?: 'round' | 'phase';
  /** The moderator's merged proposal, rendered as the room's output rather than a message. */
  proposalId?: string;
  renderProposal?: (message: Message) => React.ReactNode;
  onToggleRound: (round: number) => void;
  onOpenDiff: (messageId: string) => void;
}

/**
 * The reading column: one 940px measure, centred, with the rounds marked.
 *
 * The design makes this the whole window rather than the middle third. Rounds are the
 * structure a long room actually has, so they get dividers with anchors the round strip
 * scrolls to, and each one can be folded to a list of who said what.
 */
export function Transcript({
  view,
  tints,
  collapsed,
  unit = 'round',
  proposalId,
  renderProposal,
  onToggleRound,
  onOpenDiff,
}: TranscriptProps): React.ReactElement {
  const bottom = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow the stream, but only while the human is already at the bottom: yanking someone
  // back down while they are reading round 1 is the fastest way to make a live view useless.
  const lastMessage = view.messages[view.messages.length - 1]?.id;
  const streamed = view.pending.reduce((n, p) => n + p.text.length, 0);
  useEffect(() => {
    if (pinned.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [lastMessage, streamed, view.room?.id]);

  const onScroll = (): void => {
    const el = container.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const basePath = view.room?.worktreePath ?? view.room?.repoRoot;
  const groups = groupByRound(view.messages);

  return (
    <div
      ref={container}
      onScroll={onScroll}
      id="acr-transcript"
      className="min-h-0 flex-1 overflow-y-auto px-5"
    >
      <div className="mx-auto flex w-full max-w-[940px] flex-col gap-5 py-6">
        {groups.map((group) => {
          const folded = collapsed.has(group.round);
          return (
            <section key={group.round} className="flex flex-col gap-5">
              {group.round > 0 && (
                <button type="button" onClick={() => onToggleRound(group.round)} className="w-full">
                  <RoundDivider
                    round={group.round}
                    unit={unit}
                    summary={folded ? summarise(group) : ''}
                  />
                </button>
              )}

              {folded
                ? group.messages
                    .filter((m) => m.kind !== 'system')
                    .map((message) => (
                      <FoldedMessage
                        key={message.id}
                        message={message}
                        tint={tints[message.author]}
                      />
                    ))
                : group.messages.map((message) =>
                    message.id === proposalId && renderProposal ? (
                      <div key={message.id}>{renderProposal(message)}</div>
                    ) : message.kind === 'system' ? (
                      <SystemLine key={message.id} text={message.text} />
                    ) : (
                      <PersistedMessage
                        key={message.id}
                        message={message}
                        {...(tints[message.author] ? { tint: tints[message.author] } : {})}
                        basePath={basePath}
                        onOpenDiff={() => onOpenDiff(message.id)}
                      />
                    ),
                  )}
            </section>
          );
        })}

        {view.pending.map((pending) => (
          <MessageBubble
            key={pending.messageId}
            author={pending.author}
            role={pending.role}
            round={pending.round}
            text={pending.text}
            activity={pending.activity}
            {...(tints[pending.author] ? { tint: tints[pending.author] } : {})}
            basePath={basePath}
            streaming
          />
        ))}
        <div ref={bottom} />
      </div>
    </div>
  );
}

interface Group {
  round: number;
  messages: Message[];
}

/** Messages arrive in order, so a change of round is a boundary; round 0 is the preamble. */
function groupByRound(messages: Message[]): Group[] {
  const groups: Group[] = [];
  for (const message of messages) {
    const last = groups[groups.length - 1];
    if (last && last.round === message.round) last.messages.push(message);
    else groups.push({ round: message.round, messages: [message] });
  }
  return groups;
}

function summarise(group: Group): string {
  const agents = group.messages.filter((m) => m.kind === 'agent');
  const approvals = agents.filter((m) => m.verdict?.decision === 'approve').length;
  const votes = agents.filter((m) => m.verdict).length;
  const who = agents.map((m) => m.author).join(', ');
  const tally = votes > 0 ? `${approvals} of ${votes} approved · ` : '';
  return `${tally}${who}`;
}

/**
 * The first 160 characters of a message, on one line, marked when there is more.
 *
 * Without the ellipsis a truncated line is indistinguishable from a message that simply
 * ended there, which in a folded round is the difference between "they said this" and
 * "they said this and more you cannot see".
 */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160).trimEnd()}…` : flat;
}

/** A folded round: who spoke and how they voted, one line each. */
function FoldedMessage({
  message,
  tint,
}: {
  message: Message;
  tint?: AgentTint;
}): React.ReactElement {
  const tone = tintOf(tint);
  return (
    <div className="flex items-center gap-3.5">
      <span
        className={`flex size-7 shrink-0 items-center justify-center rounded-md border bg-raised font-mono text-[10px] ${tone.border} ${tone.text}`}
      >
        {initials(message.author)}
      </span>
      <span className={`shrink-0 font-mono text-[12px] ${tone.text}`}>{message.author}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink-faint">
        {excerpt(message.text)}
      </span>
      {message.verdict && <VerdictPill decision={message.verdict.decision} size="digest" />}
    </div>
  );
}
