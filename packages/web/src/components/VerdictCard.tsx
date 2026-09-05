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

  return (
    <div className="mt-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      {verdict ? (
        <>
          <VerdictPill decision={verdict.decision} />
          <Section
            title="Blocking"
            items={verdict.blocking}
            className="text-amber-700 dark:text-amber-400"
            basePath={basePath}
          />
          <Section
            title="Nits"
            items={verdict.nits}
            className="text-zinc-500 dark:text-zinc-400"
            basePath={basePath}
          />
        </>
      ) : (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          verdict block could not be read
        </p>
      )}

      {rawBlocks.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-xs text-zinc-500 hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
          >
            {open ? '▾' : '▸'} raw
          </button>
          {open &&
            rawBlocks.map((raw, i) => (
              <pre
                key={i}
                className="mt-1 overflow-x-auto rounded bg-zinc-100 p-2 font-mono text-[11px] leading-snug dark:bg-zinc-900"
              >
                {pretty(raw)}
              </pre>
            ))}
        </div>
      )}
    </div>
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
    <div className="mt-2">
      <h4 className={`text-[10px] font-semibold tracking-wide uppercase ${className}`}>{title}</h4>
      <ul className="mt-1 space-y-1">
        {items.map((item, i) => (
          <li key={i} className={`flex gap-1.5 text-sm ${className}`}>
            <span aria-hidden="true">•</span>
            <div className="min-w-0 flex-1">
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
