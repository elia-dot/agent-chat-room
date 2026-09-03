import type { RoomState } from '@agent-chat-room/core';

import { stateLabel } from '../lib/format.js';

/**
 * The sidebar status dot from PLAN.md section 5.1: running pulses, needs-you is amber,
 * approved green, stopped grey. Paused is hollow rather than a fifth colour – it is not a
 * state, it is a hold on one, and the ring says so without adding to the vocabulary.
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
  const colour = held ? 'text-amber-500' : COLOURS[state];
  return (
    <span
      title={stateLabel(state, paused)}
      aria-label={stateLabel(state, paused)}
      className={`inline-block size-2 shrink-0 rounded-full ${colour} ${
        held ? 'border-2 border-current bg-transparent' : 'bg-current'
      } ${state === 'running' || state === 'waiting-reviews' ? (held ? '' : 'acr-pulse') : ''} ${className}`}
    />
  );
}

const COLOURS: Record<RoomState, string> = {
  idle: 'text-zinc-400',
  running: 'text-sky-500',
  'waiting-reviews': 'text-sky-500',
  approved: 'text-emerald-500',
  'needs-you': 'text-amber-500',
  stopped: 'text-zinc-400',
};
