import { parseVerdict } from '@agent-chat-room/core';
import { describe, expect, it } from 'vitest';

import { readVerdict, splitVerdictBlocks, verdictForDisplay } from '../src/lib/verdict.js';

const REVIEW = `Two problems in \`src/auth.ts\`.

\`\`\`verdict
{"decision":"request-changes","blocking":["\`src/auth.ts:42\` drops the error"],"nits":["rename \`x\`"]}
\`\`\`
`;

describe('splitVerdictBlocks', () => {
  it('leaves a message with no fence alone', () => {
    const { body, blocks } = splitVerdictBlocks('just prose');
    expect(body).toBe('just prose');
    expect(blocks).toEqual([]);
  });

  it('lifts the block out and keeps the prose', () => {
    const { body, blocks } = splitVerdictBlocks(REVIEW);
    expect(body).toBe('Two problems in `src/auth.ts`.');
    expect(blocks).toHaveLength(1);
    expect(readVerdict(blocks[0]!)?.decision).toBe('request-changes');
  });

  it('strips every block and keeps them in order, so the last one can win', () => {
    const text = [
      'first thought',
      '```verdict',
      '{"decision":"question"}',
      '```',
      'on reflection',
      '```verdict',
      '{"decision":"approve"}',
      '```',
    ].join('\n');
    const { body, blocks } = splitVerdictBlocks(text);
    expect(body).toBe('first thought\n\non reflection');
    expect(blocks.map((b) => readVerdict(b)?.decision)).toEqual(['question', 'approve']);
  });

  it('handles CRLF line endings', () => {
    const { body, blocks } = splitVerdictBlocks(
      'prose\r\n```verdict\r\n{"decision":"approve"}\r\n```\r\n',
    );
    expect(body).toBe('prose');
    expect(blocks).toEqual(['{"decision":"approve"}']);
  });

  it('strips a trailing unclosed fence without reporting a block', () => {
    const { body, blocks } = splitVerdictBlocks('half a review\n\n```verdict\n{"decision":"appr');
    expect(body).toBe('half a review');
    expect(blocks).toEqual([]);
  });

  it('leaves a fence that is not a verdict alone', () => {
    const text = 'see\n\n```json\n{"decision":"approve"}\n```';
    expect(splitVerdictBlocks(text)).toEqual({ body: text, blocks: [] });
  });

  it('agrees with core on which block is the verdict', () => {
    const parsed = parseVerdict(REVIEW);
    expect(parsed.ok).toBe(true);
    const { blocks } = splitVerdictBlocks(REVIEW);
    expect(blocks[blocks.length - 1]).toBe(parsed.ok ? parsed.raw : null);
  });
});

describe('readVerdict', () => {
  it('reads each decision', () => {
    for (const decision of ['approve', 'request-changes', 'question']) {
      expect(readVerdict(`{"decision":"${decision}","blocking":[],"nits":[]}`)?.decision).toBe(
        decision,
      );
    }
  });

  it('defaults missing lists to empty, like the schema does', () => {
    expect(readVerdict('{"decision":"approve"}')).toEqual({
      decision: 'approve',
      blocking: [],
      nits: [],
    });
  });

  it('returns null rather than guessing a decision', () => {
    expect(readVerdict('{not json')).toBeNull();
    expect(readVerdict('"approve"')).toBeNull();
    expect(readVerdict('{"decision":"lgtm"}')).toBeNull();
    expect(readVerdict('{"decision":"approve","blocking":"nope"}')).toBeNull();
    expect(readVerdict('{"decision":"approve","nits":[1]}')).toBeNull();
  });
});

describe('a verdict printed without a fence', () => {
  it('is lifted out of the body, so the message does not repeat its own card', () => {
    const display = verdictForDisplay({
      text: 'Reviewed the diff; nothing blocking.\n{"decision":"approve","blocking":[],"nits":[]}',
      role: 'reviewer',
    });
    expect(display.body).toBe('Reviewed the diff; nothing blocking.');
    expect(display.verdict?.decision).toBe('approve');
    expect(display.unreadable).toBe(false);
  });

  it('leaves prose alone when the trailing braces are not a verdict', () => {
    const display = verdictForDisplay({
      text: 'The config ends up as {"retries":3}',
      role: 'reviewer',
    });
    expect(display.body).toBe('The config ends up as {"retries":3}');
    expect(display.verdict).toBeNull();
  });
});

describe('verdictForDisplay', () => {
  it('trusts the server verdict over a contradicting block', () => {
    const display = verdictForDisplay({
      text: REVIEW,
      role: 'reviewer',
      verdict: { decision: 'approve', blocking: [], nits: [] },
    });
    expect(display.verdict?.decision).toBe('approve');
    expect(display.body).toBe('Two problems in `src/auth.ts`.');
    expect(display.unreadable).toBe(false);
  });

  it('falls back to the text while a review is still streaming', () => {
    const display = verdictForDisplay({ text: REVIEW, role: 'reviewer' });
    expect(display.verdict).toEqual({
      decision: 'request-changes',
      blocking: ['`src/auth.ts:42` drops the error'],
      nits: ['rename `x`'],
    });
    expect(display.rawBlocks).toHaveLength(1);
  });

  it('leaves a worker message that quotes a verdict fence untouched', () => {
    const display = verdictForDisplay({ text: REVIEW, role: 'worker' });
    expect(display.body).toBe(REVIEW);
    expect(display.verdict).toBeNull();
    expect(display.rawBlocks).toEqual([]);
  });

  it('surfaces a block it cannot read instead of dropping it', () => {
    const display = verdictForDisplay({
      text: 'done\n\n```verdict\n{"decision":"approve",\n```',
      role: 'reviewer',
    });
    expect(display.verdict).toBeNull();
    expect(display.unreadable).toBe(true);
    expect(display.rawBlocks).toEqual(['{"decision":"approve",']);
    expect(display.body).toBe('done');
  });
});
