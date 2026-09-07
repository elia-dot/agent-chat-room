import type { TurnEvent } from '@agent-chat-room/core';

/**
 * One ordered slice of a turn that is still streaming: a run of prose, or the run of tool
 * calls that interrupted it.
 *
 * A turn is not prose followed by a tool log – it is prose, a tool call, more prose. The
 * accumulated text and activity list on their own cannot say which came first, so a bubble
 * built from those two has to render every paragraph and then every tool call, which is
 * not the order any of it happened in.
 *
 * The order is recovered from the socket rather than sent: `message.delta` and
 * `turn.activity` arrive in the order the engine emitted them, so appending as they land
 * is the whole of it. That is also why this lives here and not in core – the web app
 * imports nothing but types from core, which is what keeps `better-sqlite3` out of the
 * bundle.
 */
export type StreamSegment =
  { kind: 'text'; text: string } | { kind: 'activity'; events: TurnEvent[] };

/**
 * Append streamed prose, continuing the open text segment rather than starting a new one.
 *
 * Leading blank lines are dropped when a segment opens: `TurnStream` in core puts a
 * paragraph break in front of prose that follows a tool call, which is what the
 * accumulated text needs and what a segment, being its own block already, does not.
 */
export function withStreamText(segments: StreamSegment[], text: string): StreamSegment[] {
  const last = segments[segments.length - 1];
  if (last?.kind === 'text') {
    return [...segments.slice(0, -1), { kind: 'text', text: last.text + text }];
  }
  const opening = text.replace(/^\n+/, '');
  if (opening.length === 0) return segments;
  return [...segments, { kind: 'text', text: opening }];
}

/**
 * Append one activity event, coalescing consecutive ones into a single run.
 *
 * `started`, `done` and `error` are dropped: the activity drawer does not render them, and
 * letting one open a segment would split a paragraph around an empty tool log.
 */
export function withStreamActivity(segments: StreamSegment[], event: TurnEvent): StreamSegment[] {
  if (event.type !== 'tool' && event.type !== 'file') return segments;
  const last = segments[segments.length - 1];
  if (last?.kind === 'activity') {
    return [...segments.slice(0, -1), { kind: 'activity', events: [...last.events, event] }];
  }
  return [...segments, { kind: 'activity', events: [event] }];
}
