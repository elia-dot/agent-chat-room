import type { Participant, Room } from '@agent-chat-room/core';
import { useRef, useState } from 'react';

import { applyCompletion, completions, mentionAtCaret, parseMention } from '../lib/mentions.js';

export interface ComposerProps {
  room: Room;
  participants: Participant[];
  running: boolean;
  busy: boolean;
  /** Set when the socket is down: the room cannot be driven, and the composer says so. */
  offline?: boolean;
  onSend: (text: string, mention: string | null) => void;
  onPause: () => void;
  onContinue: () => void;
  onStop: () => void;
}

/**
 * The composer, and the one band above it that says what the room wants.
 *
 * A room parked in `needs-you` used to look exactly like a room sitting idle: same grey
 * hint, same enabled buttons. The design gives that state an amber band naming the three
 * real choices, because "the room is waiting for you" is the only message on this screen
 * that is addressed to the human rather than about the agents.
 */
export function Composer({
  room,
  participants,
  running,
  busy,
  offline = false,
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
  const approved = room.state === 'approved';
  const moderator = participants.find((p) => p.role === 'moderator')?.runtime;
  const needsYou = room.state === 'needs-you' && !completedBrainstorm;
  const locked = closed || offline;

  return (
    <div className="shrink-0 border-t border-line bg-surface">
      <div className="mx-auto flex w-full max-w-[940px] flex-col gap-2.5 px-5 py-3">
        {needsYou && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-question-line bg-question-bg px-3 py-2"
          >
            <span className="font-mono text-[11px] tracking-[0.1em] text-question">NEEDS YOU</span>
            <span className="h-3.5 w-px bg-question-line" />
            <span className="text-[13px] text-ink-soft">
              The room stopped and is waiting. Answer below, continue as it stands, or stop the
              room.
            </span>
          </div>
        )}

        {approved && !completedBrainstorm && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-approve-line bg-approve-bg px-3 py-2"
          >
            <span className="font-mono text-[11px] tracking-[0.1em] text-approve">FINISHED</span>
            <span className="h-3.5 w-px bg-approve-line" />
            <span className="text-[13px] text-ink-soft">
              Every reviewer approved and the round is committed. Name an agent with @ to reopen the
              room and ask for one more turn.
            </span>
          </div>
        )}

        <div className="relative">
          {suggestions.length > 0 && (
            <ul className="absolute bottom-full left-0 mb-1.5 min-w-44 overflow-hidden rounded-md border border-line bg-ground shadow-xl">
              {suggestions.map((runtime, i) => (
                <li key={runtime}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      complete(runtime);
                    }}
                    className={`block w-full px-3 py-1.5 text-left font-mono text-[12px] ${
                      i === highlight % suggestions.length
                        ? 'bg-raised text-ink'
                        : 'text-ink-dim hover:bg-raised'
                    }`}
                  >
                    @{runtime}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-start gap-2.5 rounded-md border border-line bg-ground px-3 py-2.5 focus-within:border-line-strong">
            <span className="pt-0.5 font-mono text-[13px] text-ink-faint">›</span>
            <textarea
              ref={input}
              value={value}
              rows={2}
              disabled={locked}
              placeholder={
                closed
                  ? 'This room is closed.'
                  : offline
                    ? 'Disconnected – reconnect to send.'
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
              className="min-w-0 flex-1 resize-none bg-transparent text-[14px] text-ink placeholder:text-ink-faint disabled:opacity-60"
            />
            <span className="shrink-0 pt-0.5 font-mono text-[11px] text-ink-faint">
              ↵ send · ⇧↵ newline
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
            {parsed.mention ? (
              <>
                next turn: <span className="text-ink">{parsed.mention}</span>
              </>
            ) : offline ? (
              'the room keeps working – this browser is what lost the connection'
            ) : completedBrainstorm ? (
              `reply, or @${moderator ?? 'the moderator'} to re-merge with your decision`
            ) : running ? (
              // `postUserMessage` sets `paused: true`, so sending does not just add a note
              // to a room that carries on. The turn in flight finishes; the round after it
              // does not start until you say so. This used to claim the opposite.
              'sending holds the room after this turn – continue when you are ready'
            ) : (
              'your message picks who speaks next – continue to run it'
            )}
          </span>

          {running ? (
            <Button onClick={onPause} disabled={busy || offline}>
              pause
            </Button>
          ) : (
            <Button
              onClick={onContinue}
              disabled={busy || locked || approved || completedBrainstorm}
            >
              {/* `needs-you` is neither paused nor idle, but the band above it offers to
                  "continue as it stands", so the button has to be the one it names. */}
              {room.paused || room.state === 'idle' || needsYou ? 'continue' : 'start'}
            </Button>
          )}
          <Button onClick={onStop} disabled={busy || !running || offline} tone="danger">
            stop
          </Button>
          <Button primary onClick={send} disabled={busy || locked || !parsed.text}>
            send
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
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  tone?: 'danger';
}): React.ReactElement {
  const style = primary
    ? 'bg-ink text-ground font-medium'
    : tone === 'danger'
      ? 'border border-error-line text-error hover:bg-error-bg'
      : 'border border-line text-ink-dim hover:border-line-strong hover:text-ink';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`shrink-0 rounded px-3 py-1.5 font-mono text-[11.5px] disabled:cursor-not-allowed disabled:opacity-40 ${style}`}
    >
      {children}
    </button>
  );
}
