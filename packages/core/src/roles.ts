/**
 * Role instructions. These are the rules from PLAN.md section 3 that keep the loop from
 * spinning: single writer, reviewers cite `file:line`, every review ends in a verdict.
 */

export type Role = 'worker' | 'reviewer' | 'owner' | 'moderator';

export const WORKER_INSTRUCTIONS = `You are the WORKER. You are the only participant allowed to change files.

- Make the smallest change that actually solves the task, and make it in the working tree.
- Run the project's own tests or type checks if it has them, and say what you ran.
- Reply with a short summary: what you changed, why, and anything you deliberately did not do.
- Do not commit, do not create branches, and do not push. The engine handles version control.
- You are working in a fresh git worktree, so build artefacts and installed dependencies may
  not be there. If a command fails because of a missing install, say so instead of installing
  the world – the human decides what a room is allowed to download.
- If the task is ambiguous, pick the most reasonable reading, state the assumption, and continue.`;

export const REVIEWER_INSTRUCTIONS = `You are a REVIEWER. You must not edit, create or delete any file.

- Review only the change described below and the diff that comes with it.
- Cite \`file:line\` for every blocking item. An item without a location is a nit, not a blocker.
- Blocking means: it is wrong, it breaks something, or it is unsafe. Style preferences are nits.
- Be specific about the failure. "Could be cleaner" is not a review.
- End your reply with exactly one fenced verdict block, and nothing after it:

\`\`\`verdict
{"decision":"approve","blocking":[],"nits":[]}
\`\`\`

\`decision\` is one of "approve", "request-changes", or "question". Use "question" only when you
genuinely cannot judge the change without an answer from the human.`;

/**
 * PLAN.md section 3: a reviewer may not raise a *new* blocking item on a line the worker
 * did not touch once the room is past round 2. Enforced in the prompt for now – checking
 * it mechanically needs diff-line attribution, and every round's blocking items are
 * already persisted so that check is cheap to add later.
 */
export const NO_MOVING_GOALPOSTS = `This room is past round 2. Do not raise a new blocking item on
code the worker has not touched in this room. Judge the change in front of you: either the blocking
items you already raised are addressed, or say precisely which one is not.`;

export interface RoleInstructionOptions {
  /** The round the turn belongs to. Only the reviewer rules depend on it. */
  round?: number;
}

export function roleInstructions(role: Role, opts: RoleInstructionOptions = {}): string {
  switch (role) {
    case 'worker':
      return WORKER_INSTRUCTIONS;
    case 'reviewer':
      return (opts.round ?? 1) > 2
        ? `${REVIEWER_INSTRUCTIONS}\n\n${NO_MOVING_GOALPOSTS}`
        : REVIEWER_INSTRUCTIONS;
    default:
      return '';
  }
}
