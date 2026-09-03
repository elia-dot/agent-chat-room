import type { Message, TurnEvent, Verdict } from '@agent-chat-room/core';

import { initials, runtimeClasses } from '../lib/format.js';
import { ActivityDrawer } from './ActivityDrawer.js';
import { Markdown } from './Markdown.js';
import { VerdictPill } from './VerdictPill.js';

export interface BubbleProps {
  author: string;
  role: string | null;
  round: number;
  text: string;
  activity: TurnEvent[];
  verdict?: Verdict | null;
  /** Set when the message has a diff to open in the right panel. */
  onOpenDiff?: () => void;
  diffLabel?: string;
  streaming?: boolean;
}

/** One message. PLAN.md section 5.2: avatar, role and round chips, verdict pill, drawers. */
export function MessageBubble(props: BubbleProps): React.ReactElement {
  const { author, role, round, text, activity, verdict, streaming } = props;
  return (
    <article className="flex gap-3 px-4 py-3">
      <div
        className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold ring-1 ring-inset ${runtimeClasses(author)}`}
      >
        {initials(author)}
      </div>

      <div className="min-w-0 flex-1">
        <header className="mb-1 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-medium">{author}</span>
          {role && role !== 'owner' && <Chip>{role}</Chip>}
          {round > 0 && <Chip>r{round}</Chip>}
          {verdict && <VerdictPill decision={verdict.decision} />}
          {streaming && (
            <span className="text-zinc-500">
              <span className="acr-pulse inline-block">▍</span> streaming…
            </span>
          )}
        </header>

        {text ? <Markdown text={text} /> : streaming && <p className="text-sm text-zinc-500">…</p>}

        {verdict && verdict.blocking.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-sm text-amber-700 dark:text-amber-400">
            {verdict.blocking.map((item, i) => (
              <li key={i}>• {item}</li>
            ))}
          </ul>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-3">
          <ActivityDrawer activity={activity} />
          {props.onOpenDiff && (
            <button
              type="button"
              onClick={props.onOpenDiff}
              className="text-xs text-zinc-500 hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
            >
              ▸ diff {props.diffLabel ?? ''}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

/** Same message, but from a persisted row rather than a streaming buffer. */
export function PersistedMessage({
  message,
  onOpenDiff,
}: {
  message: Message;
  onOpenDiff?: () => void;
}): React.ReactElement {
  const hasDiff = message.diff !== null || message.diffPath !== null;
  return (
    <MessageBubble
      author={message.author}
      role={message.role}
      round={message.round}
      text={message.text}
      activity={message.activity}
      verdict={message.verdict}
      {...(hasDiff && onOpenDiff ? { onOpenDiff } : {})}
    />
  );
}

function Chip({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <span className="rounded bg-zinc-200 px-1.5 py-px text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
      {children}
    </span>
  );
}
