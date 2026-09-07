import type { BrainstormPhase, Role } from './roles.js';
import { roleInstructions } from './roles.js';

/** A file the human attached to a message, as the prompt needs to describe it. */
export interface PromptAttachment {
  name: string;
  mime: string;
  path: string;
  kind: 'image' | 'doc' | 'room';
  /** Set on a `room` attachment: the room whose transcript was snapshotted. */
  roomRef?: { slug: string; title: string };
}

/** One entry in the "new messages since your last turn" section. */
export interface PromptMessage {
  author: string;
  role?: string;
  round?: number;
  text: string;
  verdict?: string;
  attachments?: PromptAttachment[];
}

export interface BuildTurnPromptInput {
  runtime: string;
  role: Role;
  title: string;
  round: number;
  cwd: string;
  branch: string;
  task: string;
  /**
   * Extra workspace roots the room granted. They are separate repositories, so their diff
   * paths are relative to themselves and a citation into one has to name the folder.
   */
  additionalDirs?: { path: string; access: 'read' | 'write' }[];
  includeRoleInstructions?: boolean;
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

/** One attachment, as a line an agent can act on. */
function describeAttachment(attachment: PromptAttachment): string {
  if (attachment.kind === 'room' && attachment.roomRef) {
    return (
      `transcript of room "${attachment.roomRef.title}" (\`${attachment.roomRef.slug}\`), ` +
      `snapshotted when it was referenced: \`${attachment.path}\``
    );
  }
  const what = attachment.kind === 'image' ? 'image' : 'document';
  return `${what} \`${attachment.name}\` (${attachment.mime}): \`${attachment.path}\``;
}

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
  if (input.additionalDirs?.length) {
    const writable = input.additionalDirs.filter((d) => d.access === 'write').map((d) => d.path);
    const readable = input.additionalDirs.filter((d) => d.access === 'read').map((d) => d.path);
    if (writable.length > 0) {
      parts.push(
        `This room also covers ${writable.join(', ')}, and you may change files there. ` +
          'Those changes are part of the room: they appear in the diff below under their own ' +
          'heading, and the room commits them and opens a pull request for them. Their paths ' +
          'are relative to their own folder, so cite them as `<folder>/<path>:<line>`.',
      );
    }
    if (readable.length > 0) {
      parts.push(
        `You may read ${readable.join(', ')} but must not change anything there. ` +
          'The room reverts any edit made in those folders at the end of the turn, so an edit ' +
          'is wasted work – say what would need to change there instead.',
      );
    }
  }
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
      // Named as absolute paths rather than pasted in: an image cannot be inlined into a
      // text prompt at all, and a referenced room's transcript is usually longer than the
      // message it is attached to. Every runtime here can open a file.
      if (m.attachments?.length) {
        parts.push('');
        parts.push('Attached, on disk – open these files:');
        for (const attachment of m.attachments) parts.push(`- ${describeAttachment(attachment)}`);
      }
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

  if (input.includeRoleInstructions !== false) {
    parts.push('');
    parts.push('## Your job now');
    parts.push(roleInstructions(input.role, { round: input.round, phase: input.phase }).trim());
  }

  return `${parts.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}
