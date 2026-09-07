import { describe, expect, it } from 'vitest';

import { composerBox, LINE, MAX_LINES } from '../src/lib/composer.js';

describe('composerBox', () => {
  it('keeps a one-line message on one line, collapsed', () => {
    expect(composerBox(LINE)).toEqual({ height: LINE, expanded: false });
  });

  it('expands as soon as the content is taller than one line', () => {
    const box = composerBox(LINE + 1);
    expect(box.expanded).toBe(true);
    expect(box.height).toBe(LINE + 1);
  });

  it('grows with the content up to the maximum', () => {
    expect(composerBox(LINE * 3)).toEqual({ height: LINE * 3, expanded: true });
  });

  it('clamps a long draft to the maximum and stays expanded', () => {
    const box = composerBox(LINE * MAX_LINES + 500);
    expect(box.height).toBe(LINE * MAX_LINES);
    expect(box.expanded).toBe(true);
  });

  it('falls back to one line when the element is not laid out yet', () => {
    // scrollHeight is 0 on first paint and in a hidden parent. Collapsing to 0 there
    // would flash an empty sliver of a box.
    expect(composerBox(0)).toEqual({ height: LINE, expanded: false });
    expect(composerBox(Number.NaN)).toEqual({ height: LINE, expanded: false });
  });

  it('never returns less than one line for an undersized measurement', () => {
    expect(composerBox(LINE - 10)).toEqual({ height: LINE, expanded: false });
  });
});
