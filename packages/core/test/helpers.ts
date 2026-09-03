import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type {
  EventSink,
  TurnEvent,
  TurnExitContext,
  TurnParser,
  TurnResult,
} from '../src/types.js';

export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

export function fixtureLines(name: string): string[] {
  return fixture(name)
    .split('\n')
    .filter((l) => l.length > 0);
}

export interface ReplayResult {
  events: TurnEvent[];
  result: TurnResult;
}

/** Feed a recorded stream through a parser exactly the way `runTurn` would. */
export function replay(
  parser: TurnParser,
  lines: string[],
  ctx: Partial<TurnExitContext> = {},
): ReplayResult {
  const events: TurnEvent[] = [];
  const sink: EventSink = (ev) => events.push(ev);
  for (const line of lines) parser.onLine(line, sink);
  const result = parser.onExit(
    {
      exitCode: 0,
      signal: null,
      stderr: '',
      cancelled: false,
      timedOut: false,
      ...ctx,
    },
    sink,
  );
  return { events, result };
}

export function eventsOfType<T extends TurnEvent['type']>(
  events: TurnEvent[],
  type: T,
): Extract<TurnEvent, { type: T }>[] {
  return events.filter((e): e is Extract<TurnEvent, { type: T }> => e.type === type);
}
