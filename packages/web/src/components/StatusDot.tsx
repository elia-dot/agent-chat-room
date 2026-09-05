import type { RoomState } from '@agent-chat-room/core';

import { stateLabel } from '../lib/format.js';

/**
 * One vocabulary for room state, shared by the dot, the header pill and the rooms overlay.
 *
 * The three outcome hues are the same ones verdicts use – a room that needs you is the
 * same amber as a question, an approved room the same green as an approval – because they
 * are the same news arriving at a different scale. Everything unremarkable stays neutral.
 */
export const STATE_TONE: Record<RoomState, { dot: string; pill: string; text: string }> = {
  idle: { dot: 'bg-ink-faint', pill: 'border-line bg-raised', text: 'text-ink-dim' },
  running: { dot: 'bg-live', pill: 'border-live-line bg-live-bg', text: 'text-live' },
  'waiting-reviews': { dot: 'bg-live', pill: 'border-live-line bg-live-bg', text: 'text-live' },
  approved: {
    dot: 'bg-approve',
    pill: 'border-approve-line bg-approve-bg',
    text: 'text-approve',
  },
  'needs-you': {
    dot: 'bg-question',
    pill: 'border-question-line bg-question-bg',
    text: 'text-question',
  },
  stopped: { dot: 'bg-changes', pill: 'border-changes-line bg-changes-bg', text: 'text-changes' },
};

export function isLive(state: RoomState): boolean {
  return state === 'running' || state === 'waiting-reviews';
}

/**
 * Paused is hollow rather than a fifth colour – it is not a state, it is a hold on one,
 * and the ring says so without adding to the vocabulary.
 */
export function StatusDot({
  state,
  paused,
  className = '',
}: {
  state: RoomState;
  paused: boolean;
  className?: string;
}): React.ReactElement {
  const held = paused && state !== 'approved';
  const tone = STATE_TONE[state];
  const label = stateLabel(state, paused);
  return (
    <span
      title={label}
      aria-label={label}
      className={`inline-block size-2 shrink-0 rounded-[2px] ${
        held ? `bg-transparent ring-1 ring-question` : tone.dot
      } ${isLive(state) && !held ? 'acr-pulse' : ''} ${className}`}
    />
  );
}

/** The state pill in the command bar: the dot plus the word, in the state's own tone. */
export function StatePill({
  state,
  paused,
  mode,
}: {
  state: RoomState;
  paused: boolean;
  mode?: 'build-review' | 'brainstorm';
}): React.ReactElement {
  const held = paused && state !== 'approved';
  const tone = STATE_TONE[state];
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 rounded border px-2 py-[3px] font-mono text-[10px] tracking-[0.1em] uppercase ${
        held ? 'border-question-line bg-question-bg text-question' : `${tone.pill} ${tone.text}`
      }`}
    >
      <span
        className={`size-1.5 rounded-full ${held ? 'bg-question' : tone.dot} ${
          isLive(state) && !held ? 'acr-pulse' : ''
        }`}
      />
      {stateLabel(state, paused, mode)}
    </span>
  );
}
