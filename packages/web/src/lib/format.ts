import type { RoomMode, RoomState } from '@agent-chat-room/core';

/** The runtime palette. Anything unknown gets the neutral chip. */
/**
 * Agent identity, per the design.
 *
 * Four tints at chroma 0.055 – sand, green, blue, violet – carried by the initials, a
 * border and the gutter hairline. They are deliberately near-grey: a verdict, a commit or
 * a failure is the only thing on screen allowed to be saturated, and four loud agent
 * colours would drown those out.
 *
 * The tint follows roster position rather than the runtime's name, because a room can hold
 * any four runtimes and `gemini` deserves an identity as much as `claude` does. Anyone not
 * in the roster (the human, a runtime that has since left) falls back to neutral.
 */
export type AgentTint = 1 | 2 | 3 | 4;

export function agentTints(runtimes: string[]): Record<string, AgentTint> {
  const tints: Record<string, AgentTint> = {};
  runtimes.forEach((runtime, index) => {
    tints[runtime] = ((index % 4) + 1) as AgentTint;
  });
  return tints;
}

/** Static class strings, because Tailwind cannot see a name it has to compute. */
const TINTS: Record<AgentTint, { text: string; border: string; rule: string; chip: string }> = {
  1: {
    text: 'text-agent-1',
    border: 'border-agent-1',
    rule: 'bg-agent-1/40',
    chip: 'bg-agent-1/20 text-agent-1',
  },
  2: {
    text: 'text-agent-2',
    border: 'border-agent-2',
    rule: 'bg-agent-2/40',
    chip: 'bg-agent-2/20 text-agent-2',
  },
  3: {
    text: 'text-agent-3',
    border: 'border-agent-3',
    rule: 'bg-agent-3/40',
    chip: 'bg-agent-3/20 text-agent-3',
  },
  4: {
    text: 'text-agent-4',
    border: 'border-agent-4',
    rule: 'bg-agent-4/40',
    chip: 'bg-agent-4/20 text-agent-4',
  },
};

const NEUTRAL = {
  text: 'text-ink-dim',
  border: 'border-line-strong',
  rule: 'bg-line',
  chip: 'bg-ink-faint/20 text-ink-dim',
};

export function tintOf(tint: AgentTint | undefined): typeof NEUTRAL {
  return tint ? TINTS[tint] : NEUTRAL;
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
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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

/**
 * The parent of a path, for the dimmed half of a recent-project row. `''` when there is no
 * parent to show – a bare name, or the root itself, where the basename already says it all.
 */
export function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  if (cut === -1) return '';
  if (cut === 0) return '/';
  return trimmed.slice(0, cut);
}
