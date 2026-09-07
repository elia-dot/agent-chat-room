import type { Attachment, Message, TurnEvent, Verdict } from '@agent-chat-room/core';

import { api } from '../api/client.js';
import type { AgentTint } from '../lib/format.js';
import { initials, relativeTime, tintOf } from '../lib/format.js';
import { verdictForDisplay } from '../lib/verdict.js';
import { ActivityDrawer } from './ActivityDrawer.js';
import { Markdown } from './Markdown.js';
import { VerdictCard } from './VerdictCard.js';
import { SPINE } from './VerdictPill.js';

export interface BubbleProps {
  author: string;
  role: string | null;
  round: number;
  text: string;
  activity: TurnEvent[];
  verdict?: Verdict | null;
  tint?: AgentTint;
  basePath?: string;
  /** Model and timing, shown after the chips. */
  meta?: string;
  /** Set when the message has a diff to open. */
  onOpenDiff?: () => void;
  diffLabel?: string;
  streaming?: boolean;
  /** Files the human put into the chat. Needs the room id to build their URLs. */
  attachments?: Attachment[];
  roomId?: string;
}

/**
 * One message.
 *
 * Identity is carried three ways at once, all of them quiet: the initials, the avatar's
 * border, and a hairline running down the gutter for the length of the message. That
 * hairline is what makes a long transcript scannable – you can see where one agent stops
 * and the next begins without reading a word – and it costs no saturation, which the
 * design reserves for verdicts.
 *
 * A message that carries a verdict thickens that hairline into a 4px spine in the verdict's
 * own colour, so the outcome of a review is visible in the margin before you read it.
 */
export function MessageBubble(props: BubbleProps): React.ReactElement {
  const { author, role, round, text, activity, verdict, basePath, streaming } = props;
  // The reviewer's ```verdict block is lifted out of the prose and rendered as a card:
  // as markdown it is a sideways-scrolling box repeating what the pill already says.
  const display = verdictForDisplay({ text, role, verdict });
  const tone = tintOf(props.tint);
  const decision = display.verdict?.decision;
  const isYou = author === 'you';

  return (
    <article className="flex gap-3.5">
      <div className="flex w-[30px] shrink-0 flex-col items-center gap-2">
        <div
          className={`flex size-7 items-center justify-center rounded-md border bg-raised font-mono text-[10px] ${
            isYou ? 'border-line-strong text-ink-dim' : `${tone.border} ${tone.text}`
          }`}
        >
          {initials(author)}
        </div>
        {/* The spine: the verdict's colour when there is one, the agent's hairline otherwise. */}
        <div
          className={`w-px flex-1 rounded-full ${
            decision ? `w-[3px] ${SPINE[decision]}` : isYou ? 'bg-line' : tone.rule
          }`}
        />
      </div>

      <div className="min-w-0 flex-1 pb-1">
        <header className="mb-2 flex flex-wrap items-center gap-2">
          <span className={`font-mono text-[12px] font-medium ${isYou ? 'text-ink' : tone.text}`}>
            {author}
          </span>
          {role && role !== 'owner' && (
            <span
              className={`rounded px-1.5 py-px font-mono text-[9px] tracking-[0.1em] uppercase ${
                isYou ? 'bg-raised text-ink-dim' : tone.chip
              }`}
            >
              {role}
            </span>
          )}
          {round > 0 && (
            <span className="rounded border border-line px-1.5 py-px font-mono text-[9px] tracking-[0.06em] text-ink-faint">
              r{round}
            </span>
          )}
          {props.meta && <span className="font-mono text-[11px] text-ink-faint">{props.meta}</span>}
          {streaming && (
            <span className="flex items-center gap-1.5 font-mono text-[11px] text-ink-faint">
              <span className="size-1.5 rounded-full bg-live acr-pulse" />
              writing
            </span>
          )}
        </header>

        <div className="text-[14.5px] leading-relaxed text-ink-soft">
          {display.body ? (
            <>
              <Markdown text={display.body} basePath={basePath} />
              {streaming && (
                <span aria-hidden="true" className="ml-0.5 inline-block acr-caret">
                  ▍
                </span>
              )}
            </>
          ) : (
            // A review whose whole reply is the fence has no prose – the card stands alone.
            !display.verdict &&
            streaming && (
              <span aria-hidden="true" className="inline-block acr-caret">
                ▍
              </span>
            )
          )}
        </div>

        {props.attachments && props.attachments.length > 0 && props.roomId && (
          <Attachments attachments={props.attachments} roomId={props.roomId} />
        )}

        <VerdictCard
          verdict={display.verdict}
          rawBlocks={display.rawBlocks}
          unreadable={display.unreadable}
          basePath={basePath}
        />

        {(activity.length > 0 || props.onOpenDiff) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <ActivityDrawer activity={activity} />
            {props.onOpenDiff && (
              <button
                type="button"
                onClick={props.onOpenDiff}
                className="rounded border border-line px-2 py-1 font-mono text-[11px] text-ink-faint hover:border-line-strong hover:text-ink"
              >
                + diff {props.diffLabel ?? ''}
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * What the human attached: images in place, everything else as a link.
 *
 * A referenced room reads as the room it came from rather than as `flaky-login.md`, because
 * that is what was meant by it – the file is an implementation detail of getting the
 * transcript in front of the agents.
 */
function Attachments({
  attachments,
  roomId,
}: {
  attachments: Attachment[];
  roomId: string;
}): React.ReactElement {
  return (
    <ul className="mt-2.5 flex flex-wrap items-start gap-2">
      {attachments.map((attachment) => {
        const href = api.attachmentUrl(roomId, attachment.id);
        if (attachment.kind === 'image') {
          return (
            <li key={attachment.id}>
              <a href={href} target="_blank" rel="noreferrer">
                <img
                  src={href}
                  alt={attachment.name}
                  className="max-h-64 max-w-full rounded-md border border-line"
                />
              </a>
            </li>
          );
        }
        return (
          <li key={attachment.id}>
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded border border-line px-2 py-1 hover:border-line-strong"
            >
              <span className="font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase">
                {attachment.kind === 'room' ? 'room' : 'doc'}
              </span>
              <span className="max-w-64 truncate text-[12.5px] text-ink-soft">
                {attachment.roomRef ? attachment.roomRef.title : attachment.name}
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** Same message, but from a persisted row rather than a streaming buffer. */
export function PersistedMessage({
  message,
  tint,
  basePath,
  onOpenDiff,
}: {
  message: Message;
  tint?: AgentTint;
  basePath?: string;
  onOpenDiff?: () => void;
}): React.ReactElement {
  const hasDiff = message.diff !== null || message.diffPath !== null;
  const meta = relativeTime(message.createdAt);
  return (
    <MessageBubble
      author={message.author}
      role={message.role}
      round={message.round}
      text={message.text}
      activity={message.activity}
      verdict={message.verdict}
      basePath={basePath}
      {...(tint ? { tint } : {})}
      {...(meta ? { meta } : {})}
      {...(hasDiff && onOpenDiff ? { onOpenDiff } : {})}
      {...(message.attachments.length > 0
        ? { attachments: message.attachments, roomId: message.roomId }
        : {})}
    />
  );
}
