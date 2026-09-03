import { describe, expect, it } from 'vitest';

import type { RoomState } from '../../src/store/types.js';
import {
  ROOM_STATES,
  assertTransition,
  canTransition,
  isResumable,
  isTerminal,
} from '../../src/engine/state.js';

const LEGAL: [RoomState, RoomState][] = [
  ['idle', 'running'],
  ['running', 'waiting-reviews'],
  ['waiting-reviews', 'approved'],
  ['waiting-reviews', 'needs-you'],
  ['waiting-reviews', 'running'],
  ['running', 'needs-you'],
  ['needs-you', 'running'],
  ['stopped', 'running'],
  ['approved', 'stopped'],
  // M2: pausing, and a single @mention turn, both come to rest in `idle`.
  ['running', 'idle'],
  ['waiting-reviews', 'idle'],
];

const ILLEGAL: [RoomState, RoomState][] = [
  ['idle', 'approved'],
  ['idle', 'waiting-reviews'],
  ['running', 'approved'],
  ['approved', 'running'],
  ['approved', 'needs-you'],
  ['needs-you', 'approved'],
  // Pausing added two edges into `idle` and no way back out of a finished room.
  ['approved', 'idle'],
  ['needs-you', 'idle'],
];

describe('the room state machine', () => {
  it('allows every transition the loop actually takes', () => {
    for (const [from, to] of LEGAL) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
      expect(() => assertTransition(from, to)).not.toThrow();
    }
  });

  it('rejects the ones it does not', () => {
    for (const [from, to] of ILLEGAL) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
      expect(() => assertTransition(from, to)).toThrow(/illegal room state transition/);
    }
  });

  it('treats staying put as legal, so a repeated setState is not an error', () => {
    for (const state of ROOM_STATES) expect(canTransition(state, state)).toBe(true);
  });

  it('knows which states are terminal and which can be picked up again', () => {
    expect(ROOM_STATES.filter(isTerminal)).toEqual(['approved', 'needs-you', 'stopped']);
    expect(isResumable('approved')).toBe(false);
    expect(isResumable('needs-you')).toBe(true);
    expect(isResumable('stopped')).toBe(true);
  });
});
