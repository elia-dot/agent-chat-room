import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';

import type {
  AgentAdapter,
  Detection,
  EventSink,
  TurnEvent,
  TurnHandle,
  TurnRequest,
  TurnResult,
} from '../types.js';

/**
 * A fake runtime that replays a script instead of spawning anything.
 *
 * This is what lets the CLI – and, from M1, the room engine – be tested end to end without
 * spending a subscription turn or depending on a network. PLAN.md schedules it for the
 * contributor guide in M4; it is here now because every test above the adapter layer needs it.
 *
 * The script comes from `ACR_ECHO_SCRIPT` (a path to a JSON file) so a test can drive the
 * real `acr run` code path.
 *
 * Turns are consumed in order *unless* they carry a `when` selector. A sequential cursor
 * alone is not enough from M1 onward: the room engine runs its reviewers in parallel, so
 * which reviewer reaches the adapter first is genuinely nondeterministic and an
 * order-only script makes every multi-reviewer test flaky. `when` keys a turn to the role,
 * round and runtime the engine writes into the prompt header, which is deterministic.
 */
export interface EchoScript {
  turns: EchoTurn[];
}

export interface EchoTurnSelector {
  /** `'worker'` or `'reviewer'`, matched against the prompt header. */
  role?: string;
  round?: number;
  runtime?: string;
}

export interface EchoTurn {
  /**
   * Match this turn against the request instead of taking it in sequence. Turns with a
   * `when` are matched first; the unkeyed ones are still consumed by the plain cursor.
   */
  when?: EchoTurnSelector;
  /** Events to emit, in order. A `done` event is appended automatically when absent. */
  events?: TurnEvent[];
  /** The turn's final message. Ignored when `events` already ends in `done`. */
  text?: string;
  /** Files to write, relative to `req.cwd`. This is how the fake worker "edits" a repo. */
  writeFiles?: Record<string, string>;
  /** Make the turn fail. */
  error?: string;
  /** Milliseconds to wait before finishing, for testing cancellation. */
  delayMs?: number;
}

let scriptCache: { path: string; script: EchoScript } | undefined;
let cursor = 0;
let consumed = new Set<number>();

/** Reset the script cursor. Tests call this between cases. */
export function resetEchoAdapter(): void {
  cursor = 0;
  consumed = new Set<number>();
  scriptCache = undefined;
}

/** The header `buildTurnPrompt` always writes first: `You are X acting as ROLE ... (round N).` */
const HEADER_RE = /^You are (\S+) acting as ([A-Z]+).*\(round (\d+)\)/m;

export function describeRequest(prompt: string): EchoTurnSelector {
  const match = HEADER_RE.exec(prompt);
  if (!match) return {};
  return {
    runtime: match[1]!,
    role: match[2]!.toLowerCase(),
    round: Number(match[3]),
  };
}

function matches(selector: EchoTurnSelector, request: EchoTurnSelector): boolean {
  if (selector.role !== undefined && selector.role !== request.role) return false;
  if (selector.round !== undefined && selector.round !== request.round) return false;
  if (selector.runtime !== undefined && selector.runtime !== request.runtime) return false;
  return true;
}

/**
 * Pick the turn this request should replay, and mark it used. Synchronous on purpose:
 * selection happens inside `run()` before any await, so two parallel reviewers can never
 * be handed the same scripted turn.
 */
function takeTurn(script: EchoScript | undefined, prompt: string): EchoTurn | undefined {
  if (!script) return undefined;
  const request = describeRequest(prompt);

  for (let i = 0; i < script.turns.length; i += 1) {
    const turn = script.turns[i]!;
    if (consumed.has(i) || !turn.when) continue;
    if (matches(turn.when, request)) {
      consumed.add(i);
      return turn;
    }
  }

  for (let i = 0; i < script.turns.length; i += 1) {
    const turn = script.turns[i]!;
    if (consumed.has(i) || turn.when) continue;
    consumed.add(i);
    return turn;
  }
  return undefined;
}

function loadScript(): EchoScript | undefined {
  const path = process.env.ACR_ECHO_SCRIPT;
  if (!path) return undefined;
  if (scriptCache?.path === path) return scriptCache.script;
  const script = JSON.parse(readFileSync(path, 'utf8')) as EchoScript;
  scriptCache = { path, script };
  return script;
}

export const echoAdapter: AgentAdapter = {
  id: 'echo',
  displayName: 'Echo (test double)',
  capabilities: { resume: true, readOnly: true, structuredOutput: false },

  detect(): Promise<Detection> {
    const enabled = Boolean(process.env.ACR_ECHO_SCRIPT);
    return Promise.resolve({
      installed: enabled,
      minVersionOk: enabled,
      version: enabled ? '0.0.0' : undefined,
      loggedIn: enabled ? true : undefined,
      note: enabled ? 'test double driven by ACR_ECHO_SCRIPT' : 'set ACR_ECHO_SCRIPT to enable',
    });
  },

  run(req: TurnRequest, sink: EventSink): TurnHandle {
    const turnId = req.turnId ?? randomUUID();
    const script = loadScript();
    const turn = takeTurn(script, req.prompt);
    const sessionId = req.sessionId ?? `echo-${turnId}`;
    cursor += 1;

    let cancelled = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let finish!: () => void;

    const done = new Promise<TurnResult>((raw) => {
      const resolve = (result: TurnResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        raw(result);
      };

      finish = (): void => {
        if (cancelled) {
          resolve({
            ok: false,
            text: '',
            exitCode: null,
            cancelled: true,
            error: 'turn cancelled',
          });
          return;
        }
        if (!turn) {
          const error = `echo adapter has no scripted turn ${cursor - 1}`;
          sink({ type: 'error', message: error });
          resolve({ ok: false, text: '', exitCode: 1, error });
          return;
        }

        // Resuming returns the session it was handed, the way a real runtime does. The
        // engine asserts on this to prove a round-2 turn continued a session rather than
        // starting a cold one.
        sink({ type: 'started', sessionId });

        for (const [rel, contents] of Object.entries(turn.writeFiles ?? {})) {
          const target = isAbsolute(rel) ? rel : join(req.cwd, rel);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, contents);
          sink({ type: 'file', path: rel, op: 'edit' });
        }

        let text = turn.text ?? '';
        if (turn.events === undefined && text) {
          // Real runtimes stream their answer before they finish. Emitting it keeps the
          // renderer (and the engine's `message.delta`) on the same code path as a real turn.
          sink({ type: 'text', text });
        }
        for (const event of turn.events ?? []) {
          if (event.type === 'done') text = event.text;
          if (event.type === 'text') text += event.text;
          sink(event);
        }

        if (turn.error) {
          sink({ type: 'error', message: turn.error });
          resolve({ ok: false, text, exitCode: 1, error: turn.error });
          return;
        }

        sink({ type: 'done', text });
        resolve({ ok: true, text, sessionId, exitCode: 0 });
      };

      if (turn?.delayMs) {
        timer = setTimeout(finish, turn.delayMs);
      } else {
        setImmediate(finish);
      }
    });

    return {
      turnId,
      cancel() {
        // Resolve rather than just clearing the timer, so a cancelled turn always settles –
        // the same guarantee `runTurn` gives for a real child process.
        cancelled = true;
        finish();
      },
      done,
    };
  },
};
