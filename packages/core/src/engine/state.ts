import type { RoomState } from '../store/types.js';

/**
 * The room state machine from PLAN.md section 4.2:
 *
 *   idle -> running(worker) -> waiting-reviews -> approved | needs-you | running(round+1)
 *                                              -> stopped (from anywhere)
 *                                              -> idle (paused, or one direct turn done)
 *
 * Every transition is persisted, which is what makes a room resumable after the process
 * dies. Keeping the legal edges in one table means an illegal transition is a loud error
 * during development instead of a room stuck in a state nothing knows how to render.
 *
 * Pausing deliberately adds no state. "The loop stopped but the room is resumable" is
 * exactly what `idle` already means, and it is where restart recovery lands a room too, so
 * everything that renders a `RoomState` keeps working. The `paused` column on the room is
 * what distinguishes a room you held from one a crash rolled back.
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
  // The worker is holding the write lock. `idle` is the pause / single-turn exit.
  running: ['waiting-reviews', 'needs-you', 'stopped', 'idle'],
  // Reviewers are running in parallel; the tally decides where this goes.
  'waiting-reviews': ['approved', 'needs-you', 'running', 'stopped', 'idle'],
  // Terminal for the engine: it will never leave `approved` on its own. The human can,
  // by naming an agent in a message – the CI that broke after the PR went up is the
  // ordinary case – which reopens the room as `needs-you` and lets the loop run again.
  approved: ['stopped', 'needs-you'],
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

/**
 * True when a room can be picked up again by `RoomEngine.run()`.
 *
 * An approved room is not: `run()` refuses it. Reopening one is a deliberate human act
 * (see `postUserMessage`), and it moves the room to `needs-you` first.
 */
export function isResumable(state: RoomState): boolean {
  return state !== 'approved';
}
