import type { Role } from './roles.js';
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
  /** Inline the diff below this size; above it, tell the agent to run git itself. */
  maxInlineDiffBytes?: number;
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
        const cmd = input.diffCommand ?? 'git diff';
        parts.push('');
        parts.push(
          `The full diff is ${Math.round(Buffer.byteLength(diff, 'utf8') / 1024)} KB, too large to inline. Run \`${cmd}\` to read it.`,
        );
      }
    }
  }

  parts.push('');
  parts.push('## Your job now');
  parts.push(roleInstructions(input.role).trim());

  return `${parts.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}
