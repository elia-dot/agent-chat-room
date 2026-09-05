import type { Message, Verdict } from '@agent-chat-room/core';
import { describe, expect, it } from 'vitest';

import { classify } from '../src/components/SystemLine.js';
import { reviewsIn, summariseRounds } from '../src/lib/rounds.js';

let seq = 0;

function agent(round: number, author: string, verdict?: Verdict['decision']): Message {
  seq += 1;
  return {
    id: `m${seq}`,
    roomId: 'r',
    seq,
    author,
    role: 'reviewer',
    kind: 'agent',
    round,
    text: 'review body',
    verdict: verdict ? { decision: verdict, blocking: [], nits: [] } : null,
    activity: [],
    diff: null,
    diffPath: null,
    createdAt: new Date().toISOString(),
  } as unknown as Message;
}

function system(round: number, text: string): Message {
  seq += 1;
  return {
    id: `s${seq}`,
    roomId: 'r',
    seq,
    author: 'system',
    role: null,
    kind: 'system',
    round,
    text,
    verdict: null,
    activity: [],
    diff: null,
    diffPath: null,
    createdAt: new Date().toISOString(),
  } as unknown as Message;
}

describe('summariseRounds', () => {
  it('colours a round by the most human-demanding thing that happened in it', () => {
    const rounds = summariseRounds(
      [
        agent(1, 'codex', 'approve'),
        agent(1, 'cursor', 'request-changes'),
        agent(2, 'codex', 'approve'),
        agent(2, 'cursor', 'question'),
        agent(3, 'codex', 'approve'),
        agent(3, 'cursor', 'approve'),
      ],
      3,
      false,
    );

    // A question outranks a request for changes, which outranks an approval: the strip is
    // scanned for what still needs a person, not for what went well.
    expect(rounds.map((r) => r.outcome)).toEqual(['changes', 'question', 'approved']);
    expect(rounds[2]).toMatchObject({ approvals: 2, votes: 2 });
  });

  it('gives an errored round its own outcome instead of request-changes', () => {
    const rounds = summariseRounds(
      [agent(4, 'claude', 'approve'), system(4, "cursor's review failed: usage limit")],
      4,
      false,
    );
    expect(rounds[0]?.outcome).toBe('errored');
  });

  it('keeps an error visible when a later reviewer returns a verdict', () => {
    const rounds = summariseRounds(
      [system(4, "cursor's review failed: timeout"), agent(4, 'claude', 'question')],
      4,
      false,
    );
    expect(rounds[0]?.outcome).toBe('errored');
  });

  it('shows the round in flight as running, whatever votes are already in', () => {
    const rounds = summariseRounds([agent(5, 'codex', 'approve')], 5, true);
    expect(rounds[0]).toMatchObject({ outcome: 'running', approvals: 1, votes: 1 });
  });

  it('ignores the preamble, which belongs to no round', () => {
    expect(summariseRounds([system(0, 'task posted')], 0, false)).toEqual([]);
  });

  it('counts the votes that are in against the reviewers a room has', () => {
    const rounds = summariseRounds([agent(2, 'codex', 'approve')], 2, false);
    expect(reviewsIn(rounds, 2, 3)).toBe('1 of 3 reviews in');
    expect(reviewsIn(rounds, 2, 0)).toBe('');
  });
});

describe('system line classification', () => {
  it('separates a round that fully approved from one that did not', () => {
    expect(classify('round 7: 3 of 3 approved.')).toMatchObject({ kind: 'approved' });
    expect(classify('round 7: 1 of 3 approved.')).toMatchObject({ kind: 'changes' });
    expect(classify('round 7: 0 of 0 approved.')).toMatchObject({ kind: 'changes' });
  });

  it('recognises the four events a returning human scans for', () => {
    expect(classify('committed dbfc0d2 on acr/terms: subject')).toMatchObject({
      kind: 'commit',
      label: 'COMMITTED',
    });
    expect(classify('opened https://github.com/o/r/pull/9')).toMatchObject({
      kind: 'pr',
      label: 'PR OPENED',
    });
    expect(classify("cursor's review failed: usage limit")).toMatchObject({ kind: 'failure' });
    expect(classify('[test runner] `npm test` finished with exit code 0')).toMatchObject({
      kind: 'note',
      label: 'TEST RUNNER',
    });
  });

  it('leaves a line it does not recognise uncoloured rather than guessing', () => {
    const parsed = classify('pushing acr/terms to origin…');
    expect(parsed.kind).toBe('note');
    expect(parsed.label).toBe('');
    expect(parsed.detail).toBe('pushing acr/terms to origin…');
  });
});
