import { describe, expect, it } from 'vitest';

import { basename, dirname } from '../src/lib/format.js';

describe('path formatting for the recent-projects list', () => {
  it('splits a path into the name a human reads and the parent they scan past', () => {
    expect(basename('/Users/you/code/agent-chat-room')).toBe('agent-chat-room');
    expect(dirname('/Users/you/code/agent-chat-room')).toBe('/Users/you/code');
  });

  it('survives the shapes a picker actually returns', () => {
    // A trailing slash: zenity's `--filename` convention, and a plausible hand-typed path.
    expect(basename('/Users/you/code/thing/')).toBe('thing');
    expect(dirname('/Users/you/code/thing/')).toBe('/Users/you/code');

    // Directly under the root: the parent is the root, not the empty string.
    expect(basename('/opt')).toBe('opt');
    expect(dirname('/opt')).toBe('/');

    // The root itself, and a bare name, have nothing above them to show.
    expect(dirname('/')).toBe('');
    expect(basename('thing')).toBe('thing');
    expect(dirname('thing')).toBe('');
  });
});
