/**
 * Pulling the ```verdict fence out of a reviewer message, for display only.
 *
 * A reviewer ends its turn with a fenced block of JSON, usually on a single line, and the
 * engine stores that reply verbatim. Rendered as markdown it becomes a `<pre>` you have to
 * scroll sideways to read, saying the same thing the verdict pill already says. So the web
 * app lifts the block out of the prose and renders it as a card.
 *
 * This is a copy of core's fence regex rather than an import: the web app aliases
 * `@agent-chat-room/core` to source and imports *types* only, because the package entry
 * pulls `better-sqlite3` in with it. `parseVerdict` in core stays the single source of
 * truth for what the engine decides – a persisted verdict always wins over anything read
 * here, so the card can never disagree with the room's state.
 */

import type { Verdict } from '@agent-chat-room/core';

/** Mirrors `FENCE_RE` in `packages/core/src/verdict.ts`. */
const FENCE_RE = /```[ \t]*verdict[ \t]*\r?\n([\s\S]*?)```/gi;

/** A fence that has been opened but not closed yet – what a half-streamed review looks like. */
const OPEN_FENCE_RE = /```[ \t]*verdict[ \t]*(?:\r?\n[\s\S]*)?$/i;

const DECISIONS = new Set(['approve', 'request-changes', 'question']);

export interface VerdictSplit {
  /** The message with its verdict blocks removed, trimmed. */
  body: string;
  /** The raw contents of each complete verdict block, in order. */
  blocks: string[];
}

/**
 * Split a message into prose and verdict blocks.
 *
 * A trailing *unclosed* fence is stripped too but never reported as a block: mid-stream
 * there is nothing to parse, and showing half a JSON object is exactly what this change
 * exists to avoid.
 */
export function splitVerdictBlocks(text: string): VerdictSplit {
  if (!text) return { body: '', blocks: [] };

  const blocks: string[] = [];
  let body = '';
  let cursor = 0;
  for (const match of text.matchAll(FENCE_RE)) {
    const at = match.index ?? 0;
    body += text.slice(cursor, at);
    cursor = at + match[0].length;
    blocks.push((match[1] ?? '').trim());
  }
  body += text.slice(cursor);

  const open = OPEN_FENCE_RE.exec(body);
  // Only when nothing else opened a fence after it – otherwise the tail belongs to some
  // other code block and is none of our business.
  if (open && !open[0].slice(3).includes('```')) {
    body = body.slice(0, open.index);
  }

  return { body: body.trim(), blocks };
}

/**
 * Read a verdict block leniently, for the cases where no server-parsed verdict exists yet.
 *
 * Hand-rolled rather than zod: the web package does not depend on zod and three field
 * checks are not worth putting it in the bundle. Anything that does not match returns
 * `null`, which the caller renders as "could not be read" instead of guessing a decision.
 */
export function readVerdict(raw: string): Verdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  if (typeof record.decision !== 'string' || !DECISIONS.has(record.decision)) return null;

  const blocking = stringArray(record.blocking);
  const nits = stringArray(record.nits);
  if (blocking === null || nits === null) return null;

  return { decision: record.decision as Verdict['decision'], blocking, nits };
}

/** `undefined` means "the reviewer left it out", which the schema defaults to `[]`. */
function stringArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  if (!value.every((item) => typeof item === 'string')) return null;
  return value;
}

export interface VerdictDisplay {
  /** What to render as markdown. */
  body: string;
  /** The verdict to render as a card, if there is one. */
  verdict: Verdict | null;
  /** The raw block text, kept behind a disclosure. */
  rawBlocks: string[];
  /** A block was found but could not be read – shown, never swallowed. */
  unreadable: boolean;
}

export interface VerdictInput {
  text: string;
  role: string | null;
  /** The verdict the server parsed. Absent on a streaming bubble, whose row does not exist yet. */
  verdict?: Verdict | null;
}

/**
 * Decide what the transcript shows for one message.
 *
 * Stripping is scoped to messages that either carry a parsed verdict or come from the
 * reviewer, so a worker quoting a ```verdict fence in a summary keeps its code block.
 */
export function verdictForDisplay({ text, role, verdict }: VerdictInput): VerdictDisplay {
  if (!verdict && role !== 'reviewer') {
    return { body: text, verdict: null, rawBlocks: [], unreadable: false };
  }

  const { body, blocks } = splitVerdictBlocks(text);
  const last = blocks.length > 0 ? blocks[blocks.length - 1]! : null;
  // The server's verdict wins: it is what drove the room's state.
  const resolved = verdict ?? (last === null ? null : readVerdict(last));

  return {
    body,
    verdict: resolved,
    rawBlocks: blocks,
    unreadable: resolved === null && blocks.length > 0,
  };
}
