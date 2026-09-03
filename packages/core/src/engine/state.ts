import type { RoomState } from '../store/types.js';

/**
 * The room state machine from PLAN.md section 4.2:
 *
 *   idle -> running(worker) -> waiting-reviews -> approved | needs-you | running(round+1)
 *                                              -> stopped (from anywhere)
 *
 * Every transition is persisted, which is what makes a room resumable after the process
 * dies. Keeping the legal edges in one table means an illegal transition is a loud error
 * during development instead of a room stuck in a state nothing knows how to render.
 */
export const ROOM_STATES = [
  'idle',
  'running',
  'waiting-reviews',
  'approved',
  'needs-you',
  'stopped',
] as const;

const TRANSITIONS: Record<RoomState, readonly RoomState[]> = {
  // A fresh room, or one rolled back by restart recovery.
  idle: ['running', 'needs-you', 'stopped'],
  // The worker is holding the write lock.
  running: ['waiting-reviews', 'needs-you', 'stopped'],
  // Reviewers are running in parallel; the tally decides where this goes.
  'waiting-reviews': ['approved', 'needs-you', 'running', 'stopped'],
  // Terminal, except that closing a room stops it.
  approved: ['stopped'],
  // The human is the next actor. Answering resumes the loop.
  'needs-you': ['running', 'stopped'],
  // Resumable: `acr rooms resume` picks a stopped room back up.
  stopped: ['running', 'idle'],
};

export function canTransition(from: RoomState, to: RoomState): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RoomState, to: RoomState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal room state transition: ${from} -> ${to}`);
  }
}

/** True when the engine has nothing left to do without the human. */
export function isTerminal(state: RoomState): boolean {
  return state === 'approved' || state === 'needs-you' || state === 'stopped';
}

/** True when a room can be picked up again by `RoomEngine.run()`. */
export function isResumable(state: RoomState): boolean {
  return state !== 'approved';
}
