import { describe, expect, it } from 'vitest';

import { Renderer, formatUsage } from '../src/render.js';
import { Capture } from './helpers.js';

const ESC = '\u001b';

function plain(): { r: Renderer; c: Capture } {
  const c = new Capture();
  return { r: new Renderer({ color: false, write: c.write }), c };
}

describe('Renderer', () => {
  it('writes no escape sequences when colour is off', () => {
    const { r, c } = plain();
    r.header('claude', 'worker', 1);
    r.event({ type: 'text', text: 'hello' });
    r.event({ type: 'done', text: 'hello' });
    expect(c.text).not.toContain(ESC);
    expect(c.text).toContain('[claude · worker · r1]');
    expect(c.text).toContain('hello');
  });

  it('paints runtimes differently when colour is on', () => {
    const c = new Capture();
    const r = new Renderer({ color: true, write: c.write });
    r.header('claude', 'worker', 1);
    r.header('codex', 'reviewer', 1);
    expect(c.text).toContain(`${ESC}[38;5;208m`);
    expect(c.text).toContain(`${ESC}[38;5;42m`);
  });

  it('keeps streaming text and dim activity lines from running together', () => {
    const { r, c } = plain();
    r.event({ type: 'text', text: 'thinking' });
    r.event({ type: 'tool', name: 'Read', summary: 'math.js' });
    expect(c.text).toBe('thinking\n  · Read math.js\n');
  });

  it('renders a verdict pill with blockers and nits', () => {
    const { r, c } = plain();
    r.verdict({
      ok: true,
      raw: '{}',
      verdict: { decision: 'request-changes', blocking: ['a.ts:1 wrong'], nits: ['rename it'] },
    });
    expect(c.text).toContain('REQUEST CHANGES');
    expect(c.text).toContain('blocking: a.ts:1 wrong');
    expect(c.text).toContain('nit: rename it');
  });

  it('says so when there is no verdict', () => {
    const { r, c } = plain();
    r.verdict({ ok: false, reason: 'no verdict block found in the reviewer message' });
    expect(c.text).toContain('no verdict');
  });
});

describe('formatUsage', () => {
  it('formats what a runtime reported and nothing else', () => {
    expect(formatUsage({ inputTokens: 6, outputTokens: 218, cachedInputTokens: 68800 })).toBe(
      'tokens: in 6 · cached 68800 · out 218',
    );
    expect(formatUsage({})).toBe('');
  });
});
