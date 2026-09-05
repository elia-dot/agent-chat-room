import type { Message } from '@agent-chat-room/core';

/**
 * What a round came to. These are the three verdict outcomes plus the two states a round
 * can be in without one: still going, or finished without any reviewer voting (a failed
 * turn, a stop).
 */
export type RoundOutcome = 'approved' | 'changes' | 'question' | 'running' | 'none';

export interface RoundSummary {
  round: number;
  outcome: RoundOutcome;
  /** How many reviewers approved, and how many voted at all. */
  approvals: number;
  votes: number;
}

/**
 * Fold the transcript into one entry per round, for the round strip.
 *
 * The strip is the design's answer to history: a 27-round room is unreadable as a scroll
 * bar, but it is perfectly readable as 27 cells coloured by outcome. Deriving that from
 * the messages rather than asking the server keeps it correct while a round is still
 * streaming, which is exactly when someone wants to look at it.
 *
 * A question outranks a request for changes, which outranks an approval: the strip should
 * show the most human-demanding thing that happened in the round, since that is what a
 * person is scanning for.
 */
export function summariseRounds(
  messages: Message[],
  currentRound: number,
  live: boolean,
): RoundSummary[] {
  const byRound = new Map<number, RoundSummary>();

  for (const message of messages) {
    if (message.round < 1) continue;
    const entry = byRound.get(message.round) ?? {
      round: message.round,
      outcome: 'none' as RoundOutcome,
      approvals: 0,
      votes: 0,
    };

    if (message.kind === 'agent' && message.role === 'reviewer' && message.verdict) {
      entry.votes += 1;
      if (message.verdict.decision === 'approve') {
        entry.approvals += 1;
        if (entry.outcome === 'none') entry.outcome = 'approved';
      } else if (message.verdict.decision === 'question') {
        entry.outcome = 'question';
      } else if (entry.outcome !== 'question') {
        entry.outcome = 'changes';
      }
    }

    // A failed turn is not a verdict, but it is why a round ended, so it should not read
    // as an approval just because the one reviewer that answered said yes.
    if (message.kind === 'system' && /failed|timeout|usage limit/i.test(message.text)) {
      if (entry.outcome === 'approved' || entry.outcome === 'none') entry.outcome = 'changes';
    }

    byRound.set(message.round, entry);
  }

  // The round in flight is a state, not an outcome, whatever votes are already in.
  if (live && currentRound >= 1) {
    const entry = byRound.get(currentRound);
    byRound.set(currentRound, {
      round: currentRound,
      outcome: 'running',
      approvals: entry?.approvals ?? 0,
      votes: entry?.votes ?? 0,
    });
  }

  return [...byRound.values()].sort((a, b) => a.round - b.round);
}

/** How many reviewers a round is waiting on, for the strip's summary line. */
export function reviewsIn(rounds: RoundSummary[], round: number, reviewers: number): string {
  const entry = rounds.find((r) => r.round === round);
  if (!entry || reviewers === 0) return '';
  return `${entry.votes} of ${reviewers} review${reviewers === 1 ? '' : 's'} in`;
}
