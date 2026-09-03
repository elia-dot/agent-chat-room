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
        className="text-xs text-zinc-500 hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
      >
        {open ? '▾' : '▸'} activity ({entries.length} {entries.length === 1 ? 'call' : 'calls'})
      </button>
      {open && (
        <ol className="mt-1 space-y-0.5 border-l border-zinc-200 pl-3 dark:border-zinc-800">
          {entries.map((event, i) => (
            <li key={i} className="font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
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
