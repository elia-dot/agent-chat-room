import { describe, expect, it } from 'vitest';

import { NO_MOVING_GOALPOSTS, roleInstructions } from '../src/roles.js';

describe('role instructions', () => {
  it('tells the worker it is the only one allowed to write, and not to commit', () => {
    const worker = roleInstructions('worker');
    expect(worker).toContain('only participant allowed to change files');
    expect(worker).toContain('Do not commit');
    // A fresh worktree has no node_modules; the worker should say so rather than install.
    expect(worker).toContain('fresh git worktree');
  });

  it('adds the no-moving-goalposts rule once the room is past round 2', () => {
    expect(roleInstructions('reviewer')).not.toContain(NO_MOVING_GOALPOSTS);
    expect(roleInstructions('reviewer', { round: 2 })).not.toContain(NO_MOVING_GOALPOSTS);
    expect(roleInstructions('reviewer', { round: 3 })).toContain(NO_MOVING_GOALPOSTS);
    // The base rules are still there; the extra rule is added, not swapped in.
    expect(roleInstructions('reviewer', { round: 3 })).toContain('```verdict');
  });

  it('has nothing to say to the owner', () => {
    expect(roleInstructions('owner')).toBe('');
  });
});
