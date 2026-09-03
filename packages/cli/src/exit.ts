/**
 * Documented exit codes. `acr run` is meant to be usable from a script, so "the reviewer
 * did not approve" has to be distinguishable from "acr itself broke".
 */
export const EXIT = {
  /** The reviewer approved. */
  ok: 0,
  /** acr failed: a runtime crashed, a turn errored, something unexpected. */
  internalError: 1,
  /** Bad usage: unknown flag, missing --task, not a git repo, dirty tree. */
  usage: 2,
  /**
   * The reviewer did not approve. Covers `request-changes`, `question`, and a reviewer
   * that never emitted a verdict block – acr will not guess an approval.
   */
  notApproved: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
