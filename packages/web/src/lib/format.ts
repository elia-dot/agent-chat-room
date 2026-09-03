import type { RoomMode, RoomState } from '@agent-chat-room/core';

/** The runtime palette from PLAN.md section 5.2. Anything unknown gets the neutral chip. */
export function runtimeClasses(author: string): string {
  switch (author) {
    case 'claude':
      return 'bg-claude/15 text-claude ring-claude/30';
    case 'codex':
      return 'bg-codex/15 text-codex ring-codex/30';
    case 'cursor':
      return 'bg-cursor/15 text-cursor ring-cursor/30';
    case 'you':
      return 'bg-zinc-500/15 text-zinc-700 ring-zinc-500/30 dark:text-zinc-300';
    default:
      return 'bg-zinc-500/15 text-zinc-600 ring-zinc-500/30 dark:text-zinc-400';
  }
}

export function initials(author: string): string {
  return author.slice(0, 2).toUpperCase();
}

/**
 * What the sidebar and the room header call each state.
 *
 * A brainstorm never approves – it ends in `needs-you` holding a proposal – so calling that
 * "needs you" reads like a stall when it is the finish line.
 */
export function stateLabel(
  state: RoomState,
  paused: boolean,
  mode: RoomMode = 'build-review',
): string {
  if (paused && state !== 'approved') return 'paused';
  if (mode === 'brainstorm') {
    if (state === 'needs-you') return 'proposed';
    if (state === 'waiting-reviews') return 'thinking';
  }
  switch (state) {
    case 'waiting-reviews':
      return 'reviewing';
    case 'needs-you':
      return 'needs you';
    default:
      return state;
  }
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** `2m 10s`, for the usage panel. Wall time is more useful here than a timestamp. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '–';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}
