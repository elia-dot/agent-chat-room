import { useEffect, useRef } from 'react';

import type { RoomView } from '../state/roomStore.js';
import { MessageBubble, PersistedMessage } from './MessageBubble.js';
import { SystemLine } from './SystemLine.js';

export interface TranscriptProps {
  view: RoomView;
  onOpenDiff: (messageId: string) => void;
}

/** The middle column: persisted messages, then whatever is still streaming. */
export function Transcript({ view, onOpenDiff }: TranscriptProps): React.ReactElement {
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

  return (
    <div ref={container} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl divide-y divide-zinc-100 dark:divide-zinc-900">
        {view.messages.map((message) =>
          message.kind === 'system' ? (
            <SystemLine key={message.id} text={message.text} />
          ) : (
            <PersistedMessage
              key={message.id}
              message={message}
              basePath={basePath}
              onOpenDiff={() => onOpenDiff(message.id)}
            />
          ),
        )}

        {view.pending.map((pending) => (
          <MessageBubble
            key={pending.messageId}
            author={pending.author}
            role={pending.role}
            round={pending.round}
            text={pending.text}
            activity={pending.activity}
            basePath={basePath}
            streaming
          />
        ))}
        <div ref={bottom} />
      </div>
    </div>
  );
}
