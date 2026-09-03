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
 * real `acr run` code path. Turns are consumed in order.
 */
export interface EchoScript {
  turns: EchoTurn[];
}

export interface EchoTurn {
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

/** Reset the script cursor. Tests call this between cases. */
export function resetEchoAdapter(): void {
  cursor = 0;
  scriptCache = undefined;
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
    const turn = script?.turns[cursor];
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

        sink({ type: 'started', sessionId: `echo-${turnId}` });

        for (const [rel, contents] of Object.entries(turn.writeFiles ?? {})) {
          const target = isAbsolute(rel) ? rel : join(req.cwd, rel);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, contents);
          sink({ type: 'file', path: rel, op: 'edit' });
        }

        let text = turn.text ?? '';
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
        resolve({ ok: true, text, sessionId: `echo-${turnId}`, exitCode: 0 });
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
