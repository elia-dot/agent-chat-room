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

describe('mechanical goalpost enforcement', () => {
  it('extracts file and line citations from verdict text', async () => {
    const { parseFileCitations } = await import('../src/verdict.js');
    expect(parseFileCitations('Check `src/index.ts:42`, `auth.js:100` and Makefile:15')).toEqual([
      { file: 'src/index.ts', line: 42 },
      { file: 'auth.js', line: 100 },
      { file: 'Makefile', line: 15 },
    ]);
    expect(parseFileCitations('no line numbers here')).toEqual([]);
    expect(parseFileCitations('round:3 failed with exit:1 and error:500')).toEqual([]);
  });

  it('downgrades blocking items on untouched code to nits and changes request-changes to approve', async () => {
    const { enforceGoalposts } = await import('../src/verdict.js');
    const diff = [
      'diff --git a/src/worker.ts b/src/worker.ts',
      'index 123..456 100644',
      '--- a/src/worker.ts',
      '+++ b/src/worker.ts',
      '@@ -10,5 +10,6 @@',
      ' line10',
      '+newline',
      ' line11',
    ].join('\n');

    // Cites untouched file untouched.ts:50 -> should downgrade
    const verdict = {
      decision: 'request-changes' as const,
      blocking: ['untouched.ts:50 fix this old bug'],
      nits: [],
    };

    const result = enforceGoalposts(verdict, diff);
    expect(result.downgraded).toHaveLength(1);
    expect(result.verdict.blocking).toEqual([]);
    expect(result.verdict.nits).toEqual(['untouched.ts:50 fix this old bug']);
    expect(result.verdict.decision).toBe('approve');

    // Cites touched line in src/worker.ts:12 -> remains blocking
    const verdict2 = {
      decision: 'request-changes' as const,
      blocking: ['src/worker.ts:12 new syntax error'],
      nits: [],
    };
    const result2 = enforceGoalposts(verdict2, diff);
    expect(result2.downgraded).toHaveLength(0);
    expect(result2.verdict.blocking).toEqual(['src/worker.ts:12 new syntax error']);
    expect(result2.verdict.decision).toBe('request-changes');
  });
});
