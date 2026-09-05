import { describe, expect, it } from 'vitest';

import { decisionLabel, parseVerdict, verdictJsonSchema } from '../src/verdict.js';

describe('parseVerdict', () => {
  it('reads a well formed block', () => {
    const parsed = parseVerdict(
      'Looks right to me.\n\n```verdict\n{"decision":"approve","blocking":[],"nits":["name the constant"]}\n```',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.verdict.decision).toBe('approve');
    expect(parsed.verdict.nits).toEqual(['name the constant']);
  });

  it('defaults blocking and nits so a terse verdict still validates', () => {
    const parsed = parseVerdict('```verdict\n{"decision":"approve"}\n```');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.verdict.blocking).toEqual([]);
    expect(parsed.verdict.nits).toEqual([]);
  });

  it('takes the last block when a reviewer changes its mind mid-message', () => {
    const parsed = parseVerdict(
      '```verdict\n{"decision":"approve"}\n```\nActually, on reflection:\n```verdict\n{"decision":"request-changes","blocking":["a.ts:1 nope"]}\n```',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.verdict.decision).toBe('request-changes');
    expect(parsed.verdict.blocking).toEqual(['a.ts:1 nope']);
  });

  it('uses a runtime structured result when the visible verdict JSON is malformed', () => {
    const parsed = parseVerdict('```verdict\n{"decision":"approve}\n```', {
      decision: 'request-changes',
      blocking: ['a.ts:1 is still broken'],
      nits: [],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.verdict.decision).toBe('request-changes');
    expect(parsed.verdict.blocking).toEqual(['a.ts:1 is still broken']);
  });

  it('falls back to the visible verdict when a runtime structured result is invalid', () => {
    const parsed = parseVerdict('```verdict\n{"decision":"approve"}\n```', {
      decision: 'maybe',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.verdict.decision).toBe('approve');
  });

  it('tolerates prose around the fence and whitespace after the language tag', () => {
    const parsed = parseVerdict('before\n```verdict  \n  {"decision":"question"}  \n```\nafter');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.verdict.decision).toBe('question');
  });

  it('reports a missing block rather than guessing', () => {
    const parsed = parseVerdict('LGTM, ship it');
    expect(parsed).toEqual({
      ok: false,
      reason: 'no ```verdict block found in the reviewer message',
    });
  });

  it('reports an empty message', () => {
    const parsed = parseVerdict('   ');
    expect(parsed.ok).toBe(false);
  });

  it('reports malformed JSON with the parser message', () => {
    const parsed = parseVerdict('```verdict\n{"decision": approve}\n```');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('not valid JSON');
  });

  it('rejects an unknown decision', () => {
    const parsed = parseVerdict('```verdict\n{"decision":"looks-fine"}\n```');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('does not match the schema');
    expect(parsed.reason).toContain('decision');
  });

  it('rejects blocking items that are not strings', () => {
    const parsed = parseVerdict(
      '```verdict\n{"decision":"request-changes","blocking":[{"file":"a"}]}\n```',
    );
    expect(parsed.ok).toBe(false);
  });
});

describe('verdictJsonSchema', () => {
  it('describes the same three decisions the parser accepts', () => {
    expect(verdictJsonSchema.properties.decision.enum).toEqual([
      'approve',
      'request-changes',
      'question',
    ]);
  });
});

describe('decisionLabel', () => {
  it('labels every decision', () => {
    expect(decisionLabel('approve')).toBe('APPROVE');
    expect(decisionLabel('request-changes')).toBe('REQUEST CHANGES');
    expect(decisionLabel('question')).toBe('QUESTION');
  });
});
