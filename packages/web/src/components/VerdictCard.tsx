import type { Verdict } from '@agent-chat-room/core';
import { useState } from 'react';

import { Markdown } from './Markdown.js';
import { VerdictPill } from './VerdictPill.js';

export interface VerdictCardProps {
  verdict: Verdict | null;
  /** The raw ```verdict block(s), kept behind a disclosure. */
  rawBlocks: string[];
  /** A block was found but could not be read. */
  unreadable: boolean;
  basePath?: string;
}

/**
 * A reviewer's verdict, rendered for a human rather than as the JSON it arrived as.
 *
 * The design asks for a size difference, not just a colour one: an approval with nothing
 * blocking digests to a single line, because it is good news that needs no action, while a
 * verdict that asks something of you keeps the full pill and its blocking list. In a room
 * where three reviewers approve every round, that is the difference between a transcript
 * you can skim and three identical green cards per round.
 *
 * Items go through `Markdown` because reviewers are told to cite `file:line` in backticks,
 * and a plain `<li>` would print the backticks. The raw block stays one click away: the
 * verdict is a contract, and being able to read the literal bytes is worth a collapsed row.
 */
export function VerdictCard({
  verdict,
  rawBlocks,
  unreadable,
  basePath,
}: VerdictCardProps): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  if (!verdict && !unreadable) return null;

  const digest =
    verdict?.decision === 'approve' && verdict.blocking.length === 0 && verdict.nits.length === 0;

  if (digest) {
    return (
      <div className="mt-2 flex items-center gap-3">
        <VerdictPill decision="approve" size="digest" />
        {rawBlocks.length > 0 && <RawToggle open={open} onToggle={() => setOpen((v) => !v)} />}
        {open && <Raw blocks={rawBlocks} />}
      </div>
    );
  }

  return (
    <div className="mt-2.5 rounded-md border border-line bg-surface p-3">
      {verdict ? (
        <>
          <div className="flex">
            <VerdictPill decision={verdict.decision} />
          </div>
          <Section
            title="Blocking"
            items={verdict.blocking}
            className="text-changes"
            basePath={basePath}
          />
          <Section title="Nits" items={verdict.nits} className="text-ink-dim" basePath={basePath} />
        </>
      ) : (
        <p className="font-mono text-[11.5px] text-error">
          verdict block could not be read – counted as not approved
        </p>
      )}

      {rawBlocks.length > 0 && (
        <div className="mt-2.5">
          <RawToggle open={open} onToggle={() => setOpen((v) => !v)} />
          {open && <Raw blocks={rawBlocks} />}
        </div>
      )}
    </div>
  );
}

function RawToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="font-mono text-[11px] text-ink-faint hover:text-ink"
    >
      {open ? '▾' : '+'} raw
    </button>
  );
}

function Raw({ blocks }: { blocks: string[] }): React.ReactElement {
  return (
    <>
      {blocks.map((raw, i) => (
        <pre
          key={i}
          className="mt-1.5 overflow-x-auto rounded border border-line bg-raised p-2.5 font-mono text-[11px] leading-snug text-ink-soft"
        >
          {pretty(raw)}
        </pre>
      ))}
    </>
  );
}

function Section({
  title,
  items,
  className,
  basePath,
}: {
  title: string;
  items: string[];
  className: string;
  basePath?: string;
}): React.ReactElement | null {
  if (items.length === 0) return null;
  return (
    <div className="mt-2.5">
      <h4 className={`font-mono text-[10px] font-medium tracking-[0.12em] uppercase ${className}`}>
        {title}
      </h4>
      <ul className="mt-1.5 space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2 text-[13.5px]">
            <span aria-hidden="true" className={`select-none ${className}`}>
              •
            </span>
            <div className="min-w-0 flex-1 text-ink-soft">
              <Markdown text={item} basePath={basePath} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One-line JSON is what reviewers send; indent it so the disclosure is worth opening. */
function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
