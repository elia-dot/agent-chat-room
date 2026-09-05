import type { Verdict } from '@agent-chat-room/core';

type Decision = Verdict['decision'];

/**
 * Filled, not tinted, and carrying a glyph.
 *
 * The design's rule: the decision is the single most important thing in a review and has
 * to be readable from across the room. A glyph does the work colour cannot – it survives
 * a colour-blind reader, a bad monitor and a screenshot pasted into a chat – so approve,
 * request-changes and question are never distinguished by hue alone.
 */
const TONE: Record<Decision, { fill: string; quiet: string; glyph: string; label: string }> = {
  approve: {
    fill: 'bg-approve text-ground',
    quiet: 'text-approve',
    glyph: '✓',
    label: 'APPROVE',
  },
  'request-changes': {
    fill: 'bg-changes text-ground',
    quiet: 'text-changes',
    glyph: '!',
    label: 'REQUEST CHANGES',
  },
  question: {
    fill: 'bg-question text-ground',
    quiet: 'text-question',
    glyph: '?',
    label: 'QUESTION',
  },
};

export function verdictTone(decision: Decision): (typeof TONE)[Decision] {
  return TONE[decision];
}

/** The spine colour down the gutter of a message that carries a verdict. */
export const SPINE: Record<Decision, string> = {
  approve: 'bg-approve',
  'request-changes': 'bg-changes',
  question: 'bg-question',
};

export function VerdictPill({
  decision,
  size = 'full',
}: {
  decision: Decision;
  /** `full` for a verdict that needs answering, `digest` for an approval. */
  size?: 'full' | 'digest';
}): React.ReactElement {
  const tone = TONE[decision];
  if (size === 'digest') {
    return (
      <span
        className={`flex items-center gap-1.5 font-mono text-[11px] font-medium tracking-[0.08em] ${tone.quiet}`}
      >
        <span aria-hidden="true">{tone.glyph}</span>
        {tone.label}
      </span>
    );
  }
  return (
    <span
      className={`flex items-center gap-2 rounded-[5px] px-3 py-1.5 font-mono text-[13px] font-semibold tracking-[0.12em] ${tone.fill}`}
    >
      <span aria-hidden="true" className="text-[14px]">
        {tone.glyph}
      </span>
      {tone.label}
    </span>
  );
}
