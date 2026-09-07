import type { Message } from '@agent-chat-room/core';

import type { AgentTint } from '../lib/format.js';
import { initials, relativeTime, tintOf } from '../lib/format.js';
import { Markdown } from './Markdown.js';

export interface ProposalCardProps {
  message: Message;
  tint?: AgentTint;
  /** How much discussion went into it, for the line under the header. */
  answers: number;
  reactions: number;
  basePath?: string;
  busy: boolean;
  canPromote: boolean;
  exportHref: string;
  onPromote: () => void;
  onAnotherRound: () => void;
}

/**
 * The merged proposal, given the weight of an output rather than of another message.
 *
 * A brainstorm produces exactly one thing, and in the old transcript it was the last grey
 * bubble in a column of grey bubbles. The design gives it a card, a header that names who
 * merged it, and the three things you can do with it. It also says out loud that there are
 * no verdicts here, because a room full of agents that never approve anything otherwise
 * reads as a room that failed.
 *
 * The body is the moderator's markdown, rendered as written. The role prompt asks for a
 * "Proposed task" section but nothing enforces one, so this does not invent headings the
 * moderator did not write.
 */
export function ProposalCard(props: ProposalCardProps): React.ReactElement {
  const { message } = props;
  const tone = tintOf(props.tint);

  return (
    <section id="acr-proposal" className="scroll-mt-4 rounded-lg border border-approve-line">
      <header className="flex flex-wrap items-center gap-2.5 border-b border-approve-line bg-approve-bg px-4 py-2.5">
        <span className="font-mono text-[11px] tracking-[0.14em] text-approve">FINAL PROPOSAL</span>
        <span className="h-3.5 w-px bg-approve-line" />
        <span
          className={`flex size-5 items-center justify-center rounded border bg-raised font-mono text-[9px] ${tone.border} ${tone.text}`}
        >
          {initials(message.author)}
        </span>
        <span className="font-mono text-[11.5px] text-ink-soft">
          merged by {message.author} · moderator
        </span>
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-ink-faint">
          {props.answers} answers · {props.reactions} reactions in ·{' '}
          {relativeTime(message.createdAt)}
        </span>
      </header>

      <div className="px-4 py-3.5 text-[15px] leading-relaxed text-ink-soft">
        <Markdown text={message.text} basePath={props.basePath} />
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
        <span className="min-w-0 flex-1 font-mono text-[11px] text-ink-faint">
          no verdicts in brainstorm mode – the proposal is the output
        </span>
        <a
          href={props.exportHref}
          download
          className="rounded border border-line px-2.5 py-1.5 font-mono text-[11.5px] text-ink-dim hover:border-line-strong hover:text-ink"
        >
          export markdown
        </a>
        <button
          type="button"
          onClick={props.onAnotherRound}
          disabled={props.busy}
          className="rounded border border-line px-2.5 py-1.5 font-mono text-[11.5px] text-ink-dim hover:border-line-strong hover:text-ink disabled:opacity-40"
        >
          another round of reactions
        </button>
        <button
          type="button"
          onClick={props.onPromote}
          disabled={props.busy || !props.canPromote}
          className="rounded bg-ink px-3 py-1.5 font-mono text-[11.5px] text-ground disabled:opacity-40"
        >
          open build room from this
        </button>
      </footer>
    </section>
  );
}
