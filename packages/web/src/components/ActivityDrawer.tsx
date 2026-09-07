import type { TurnEvent } from '@agent-chat-room/core';
import { useState } from 'react';

/** The collapsible tool log under an agent message (PLAN.md section 5.2). */
export function ActivityDrawer({ activity }: { activity: TurnEvent[] }): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const entries = activity.filter((e) => e.type === 'tool' || e.type === 'file');
  if (entries.length === 0) return null;

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="font-mono text-[11px] text-ink-faint hover:text-ink hover:underline"
      >
        {open ? '▾' : '▸'} activity ({entries.length} {entries.length === 1 ? 'call' : 'calls'})
      </button>
      {open && (
        <ol className="mt-1 space-y-0.5 border-l border-line pl-3">
          {entries.map((event, i) => (
            <li key={i} className="font-mono text-[11px] text-ink-dim">
              {event.type === 'tool' ? (
                <>
                  <b className="font-semibold">{event.name}</b> {event.summary}
                </>
              ) : (
                <>
                  <b className="font-semibold">{event.op}</b> {event.path}
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
