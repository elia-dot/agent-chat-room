import { describe, expect, it } from 'vitest';

import { withStreamActivity, withStreamText } from '../src/state/segments.js';

describe('stream segments', () => {
  it('continues the open text segment instead of starting another', () => {
    const one = withStreamText([], 'half a ');
    expect(withStreamText(one, 'sentence')).toEqual([{ kind: 'text', text: 'half a sentence' }]);
  });

  it('drops the paragraph break when it opens a segment', () => {
    // The engine puts `\n\n` in front of prose that follows a tool call, which the
    // accumulated text needs. A segment is its own block, so it would render as a gap.
    const segments = withStreamActivity([], { type: 'tool', name: 'Read', summary: 'x.js' });
    expect(withStreamText(segments, '\n\nNow the test.')).toEqual([
      { kind: 'activity', events: [{ type: 'tool', name: 'Read', summary: 'x.js' }] },
      { kind: 'text', text: 'Now the test.' },
    ]);
  });

  it('opens no segment for prose that is nothing but the break', () => {
    const segments = withStreamActivity([], { type: 'file', path: 'a.js', op: 'edit' });
    expect(withStreamText(segments, '\n\n')).toEqual(segments);
  });

  it('coalesces consecutive tool calls into one run', () => {
    let segments = withStreamText([], 'reading');
    segments = withStreamActivity(segments, { type: 'tool', name: 'Read', summary: 'x.js' });
    segments = withStreamActivity(segments, { type: 'file', path: 'x.js', op: 'edit' });

    expect(segments).toEqual([
      { kind: 'text', text: 'reading' },
      {
        kind: 'activity',
        events: [
          { type: 'tool', name: 'Read', summary: 'x.js' },
          { type: 'file', path: 'x.js', op: 'edit' },
        ],
      },
    ]);
  });

  it('ignores the events the activity drawer does not render', () => {
    const segments = withStreamText([], 'one');
    expect(withStreamActivity(segments, { type: 'started', sessionId: 's1' })).toEqual(segments);
    expect(withStreamActivity(segments, { type: 'done', text: 'bye' })).toEqual(segments);
    expect(withStreamActivity(segments, { type: 'error', message: 'no' })).toEqual(segments);
  });
});
