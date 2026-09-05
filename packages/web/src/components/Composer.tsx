import type { Participant, Room } from '@agent-chat-room/core';
import { useRef, useState } from 'react';

import { applyCompletion, completions, mentionAtCaret, parseMention } from '../lib/mentions.js';

export interface ComposerProps {
  room: Room;
  participants: Participant[];
  running: boolean;
  busy: boolean;
  onSend: (text: string, mention: string | null) => void;
  onPause: () => void;
  onContinue: () => void;
  onStop: () => void;
}

/**
 * PLAN.md section 5.3: a textarea, `@runtime` autocomplete, Enter to send, and the
 * pause/continue/stop buttons. Sending holds the loop and routes the next turn to the
 * mention – the engine does that part; this only has to say who was named.
 */
export function Composer({
  room,
  participants,
  running,
  busy,
  onSend,
  onPause,
  onContinue,
  onStop,
}: ComposerProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);

  const runtimes = participants.map((p) => p.runtime);
  const mention = mentionAtCaret(value, caret);
  const suggestions = mention ? completions(mention.query, runtimes) : [];
  const parsed = parseMention(value, runtimes);

  const complete = (runtime: string): void => {
    if (!mention) return;
    const next = applyCompletion(value, mention, runtime);
    setValue(next.value);
    setCaret(next.caret);
    setHighlight(0);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const send = (): void => {
    if (!parsed.text || busy) return;
    onSend(parsed.text, parsed.mention);
    setValue('');
    setCaret(0);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (suggestions.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : suggestions.length - 1;
        setHighlight((h) => (h + delta) % suggestions.length);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        complete(suggestions[highlight] ?? suggestions[0]!);
        return;
      }
    }
    // Enter sends, shift+Enter is a newline. A room message is usually one sentence.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const closed = room.closedAt !== null;
  const completedBrainstorm = room.mode === 'brainstorm' && room.round >= room.maxRounds;

  return (
    <div className="border-t border-zinc-200 dark:border-zinc-800">
      <div className="relative mx-auto max-w-3xl p-3">
        {suggestions.length > 0 && (
          <ul className="absolute bottom-full left-3 mb-1 min-w-40 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
            {suggestions.map((runtime, i) => (
              <li key={runtime}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    complete(runtime);
                  }}
                  className={`block w-full px-3 py-1.5 text-left text-sm ${
                    i === highlight % suggestions.length
                      ? 'bg-zinc-100 dark:bg-zinc-800'
                      : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
                  }`}
                >
                  @{runtime}
                </button>
              </li>
            ))}
          </ul>
        )}

        <textarea
          ref={input}
          value={value}
          rows={2}
          disabled={closed}
          placeholder={
            closed
              ? 'This room is closed.'
              : `Message the room…  ${runtimes.map((r) => `@${r}`).join(' ')}`
          }
          onChange={(e) => {
            setValue(e.target.value);
            setCaret(e.target.selectionStart);
            setHighlight(0);
          }}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          className="w-full resize-none rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:ring-2 focus:ring-sky-500 focus:outline-none disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
        />

        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 text-xs text-zinc-500">
            {parsed.mention ? (
              <>
                next turn: <b>{parsed.mention}</b>
              </>
            ) : (
              <>
                {completedBrainstorm
                  ? 'Send feedback to revise via the moderator · '
                  : 'Enter to send · '}
                Shift+Enter for a newline
              </>
            )}
          </div>

          {running ? (
            <Button onClick={onPause} disabled={busy}>
              Pause
            </Button>
          ) : (
            <Button
              onClick={onContinue}
              disabled={busy || closed || room.state === 'approved' || completedBrainstorm}
            >
              {room.paused || room.state === 'idle' ? 'Continue' : 'Start'}
            </Button>
          )}
          <Button onClick={onStop} disabled={busy || !running}>
            Stop
          </Button>
          <Button primary onClick={send} disabled={busy || closed || !parsed.text}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

function Button({
  children,
  onClick,
  disabled,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
        primary
          ? 'bg-sky-600 text-white hover:bg-sky-500'
          : 'border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  );
}
