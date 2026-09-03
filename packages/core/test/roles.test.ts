import { describe, expect, it } from 'vitest';

import {
  BRAINSTORM_ANSWER_INSTRUCTIONS,
  BRAINSTORM_REACT_INSTRUCTIONS,
  MODERATOR_INSTRUCTIONS,
  NO_MOVING_GOALPOSTS,
  roleInstructions,
} from '../src/roles.js';

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

  it('gives each brainstorm phase its own instructions, and none of them mention a verdict', () => {
    const answer = roleInstructions('reviewer', { phase: 'answer' });
    const react = roleInstructions('reviewer', { phase: 'react' });
    expect(answer).toBe(BRAINSTORM_ANSWER_INSTRUCTIONS);
    expect(react).toBe(BRAINSTORM_REACT_INSTRUCTIONS);
    expect(answer).not.toBe(react);
    for (const text of [answer, react, MODERATOR_INSTRUCTIONS]) {
      expect(text).not.toContain('```verdict');
      // Nobody edits in a brainstorm, and every phase has to say so.
      expect(text).toContain('Do not edit');
    }
  });

  it('lets the phase win over the role, so the moderator answers before it merges', () => {
    // The moderator takes part in rounds 1 and 2 like everyone else (PLAN.md section 3);
    // merging is only what it does in round 3.
    expect(roleInstructions('moderator', { phase: 'answer' })).toBe(BRAINSTORM_ANSWER_INSTRUCTIONS);
    expect(roleInstructions('moderator', { phase: 'merge' })).toBe(MODERATOR_INSTRUCTIONS);
    expect(roleInstructions('moderator')).toBe(MODERATOR_INSTRUCTIONS);
    expect(MODERATOR_INSTRUCTIONS).toContain('Proposed task');
  });

  it('leaves the build-review instructions alone when no phase is given', () => {
    expect(roleInstructions('reviewer')).toContain('```verdict');
    expect(roleInstructions('worker')).toContain('only participant allowed to change files');
  });
});
