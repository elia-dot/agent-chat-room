import type { Verdict } from '@agent-chat-room/core';

const STYLES: Record<Verdict['decision'], string> = {
  approve: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  'request-changes': 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  question: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
};

const LABELS: Record<Verdict['decision'], string> = {
  approve: 'APPROVE',
  'request-changes': 'REQUEST CHANGES',
  question: 'QUESTION',
};

/**
 * The verdict pill on a reviewer message. A message with no pill is not an approval –
 * `acr` never guesses one – so the absence has to read as absence rather than as neutral.
 */
export function VerdictPill({ decision }: { decision: Verdict['decision'] }): React.ReactElement {
  return (
    <span
      className={`rounded px-1.5 py-px text-[10px] font-semibold tracking-wide ${STYLES[decision]}`}
    >
      {LABELS[decision]}
    </span>
  );
}
