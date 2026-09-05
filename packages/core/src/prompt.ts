import type { BrainstormPhase, Role } from './roles.js';
import { roleInstructions } from './roles.js';

/** One entry in the "new messages since your last turn" section. */
export interface PromptMessage {
  author: string;
  role?: string;
  round?: number;
  text: string;
  verdict?: string;
}

export interface BuildTurnPromptInput {
  runtime: string;
  role: Role;
  title: string;
  round: number;
  cwd: string;
  branch: string;
  task: string;
  newMessages?: PromptMessage[];
  diffStat?: string;
  diff?: string;
  /** Command the agent should run to see the diff itself when it is too big to inline. */
  diffCommand?: string;
  /**
   * Absolute path of the diff, written out when it is too big to inline. A read-only
   * reviewer has no shell, so `git diff` is useless advice to it; reading a file is the
   * one thing every read-only permission level still allows.
   */
  diffFile?: string;
  /** Inline the diff below this size; above it, tell the agent to run git itself. */
  maxInlineDiffBytes?: number;
  /**
   * Rendered just before "## Your job now" when this participant's role changed since its
   * last turn. Codex and Cursor only see role instructions on the first prompt of a session
   * (their resume path has no system-prompt flag), so a swapped participant would otherwise
   * carry on with the instructions it was given as something else.
   */
  roleChanged?: string;
  /** Brainstorm phase, passed through to `roleInstructions`. */
  phase?: BrainstormPhase;
  /** Test runner output to inject into reviewer prompts. */
  testResults?: string;
}

export const DEFAULT_MAX_INLINE_DIFF_BYTES = 60 * 1024;

/**
 * The per-turn prompt layout from PLAN.md section 4.2.
 *
 * Sessions are resumed rather than replayed, so this only ever carries what the agent has
 * not seen: the task, the messages since its last turn, and the current state of the diff.
 */
export function buildTurnPrompt(input: BuildTurnPromptInput): string {
  const maxInline = input.maxInlineDiffBytes ?? DEFAULT_MAX_INLINE_DIFF_BYTES;
  const parts: string[] = [];

  parts.push(
    `You are ${input.runtime} acting as ${input.role.toUpperCase()} in room "${input.title}" (round ${input.round}).`,
  );
  parts.push(`Repo: ${input.cwd} on branch ${input.branch}.`);
  parts.push('');
  parts.push('## Task');
  parts.push(input.task.trim());

  const messages = input.newMessages ?? [];
  if (messages.length > 0) {
    parts.push('');
    parts.push('## New messages since your last turn');
    for (const m of messages) {
      const meta = [m.author, m.role, m.round === undefined ? undefined : `round ${m.round}`]
        .filter(Boolean)
        .join(' · ');
      const verdict = m.verdict ? ` (verdict: ${m.verdict})` : '';
      parts.push(`[${meta}]${verdict}`);
      parts.push(m.text.trim());
      parts.push('');
    }
    if (parts[parts.length - 1] === '') parts.pop();
  }

  const hasDiff = Boolean(input.diffStat?.trim() || input.diff?.trim());
  if (hasDiff) {
    parts.push('');
    parts.push('## Changes in this room so far');
    if (input.diffStat?.trim()) {
      parts.push('```');
      parts.push(input.diffStat.trim());
      parts.push('```');
    }
    const diff = input.diff ?? '';
    if (diff.trim()) {
      if (Buffer.byteLength(diff, 'utf8') <= maxInline) {
        parts.push('');
        parts.push('```diff');
        parts.push(diff.replace(/\n+$/, ''));
        parts.push('```');
      } else {
        const kb = Math.round(Buffer.byteLength(diff, 'utf8') / 1024);
        const cmd = input.diffCommand ?? 'git diff';
        parts.push('');
        parts.push(
          input.diffFile
            ? `The full diff is ${kb} KB, too large to inline. It has been written to \`${input.diffFile}\` – read that file. If you have a shell, \`${cmd}\` shows the same thing.`
            : `The full diff is ${kb} KB, too large to inline. Run \`${cmd}\` to read it.`,
        );
      }
    }
  }

  if (input.testResults?.trim()) {
    parts.push('');
    parts.push('## Test Results');
    parts.push(input.testResults.trim());
  }

  if (input.roleChanged?.trim()) {
    parts.push('');
    parts.push('## Your role has changed');
    parts.push(input.roleChanged.trim());
  }

  parts.push('');
  parts.push('## Your job now');
  parts.push(roleInstructions(input.role, input.phase ? { phase: input.phase } : {}).trim());

  return `${parts.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}
