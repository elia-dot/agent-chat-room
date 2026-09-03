import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { TurnLog } from '../turnLog.js';
import type { EventSink, TurnHandle, TurnParser, TurnResult } from '../types.js';
import { LineSplitter } from './lines.js';

export interface RunTurnOptions {
  argv: string[];
  cwd: string;
  /** Written to the child's stdin, which is then closed. */
  stdin: string;
  /**
   * Per-read stall timeout: the clock resets on every byte the child produces, so a long
   * but chatty turn is fine and a genuinely wedged one is not.
   */
  timeoutMs: number;
  parser: TurnParser;
  sink: EventSink;
  turnId?: string;
  /** Milliseconds to wait for a signalled child to exit before SIGKILL. */
  exitGraceMs?: number;
  /** Run after the child exits, whatever happened. Used to delete temp schema files. */
  cleanup?: () => void;
  env?: NodeJS.ProcessEnv;
}

const STDERR_CAP = 64 * 1024;
const DEFAULT_EXIT_GRACE_MS = 30_000;

/**
 * The one place in the project that spawns a process.
 *
 * Everything unpleasant about driving someone else's CLI lives here so the adapters can
 * stay pure argv-plus-parser:
 *
 *  - `shell: false` always, so a repo path with a space or a `;` is data, not code.
 *  - stderr is drained concurrently for the whole child lifetime. A chatty CLI that fills
 *    the 64 KB OS pipe buffer while we only read stdout deadlocks forever, and it is not
 *    the kind of bug you find twice.
 *  - the prompt goes in on stdin and stdin is *closed*, because both `claude -p` and
 *    `codex exec` wait for EOF before they start.
 *  - a stall timeout, an exit grace period, and a kill in `finally`, so a cancelled or
 *    timed-out turn never leaves a live child holding a subscription slot.
 *  - no env injection. Each CLI finds its own login on disk or in the keychain; that is
 *    the entire point of the project and the reason we never touch credentials.
 */
export function runTurn(opts: RunTurnOptions): TurnHandle {
  const turnId = opts.turnId ?? randomUUID();
  const exitGraceMs = opts.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;
  const log = new TurnLog(turnId);
  const splitter = new LineSplitter();

  let settled = false;
  let cancelled = false;
  let timedOut = false;
  let spawnError: string | undefined;
  let stderr = '';
  let stallTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  let resolveDone!: (r: TurnResult) => void;
  const done = new Promise<TurnResult>((resolve) => {
    resolveDone = resolve;
  });

  const emit: EventSink = (event) => {
    try {
      opts.sink(event);
    } catch {
      // A broken renderer must not take the turn down.
    }
  };

  const [bin, ...args] = opts.argv;
  if (bin === undefined) {
    throw new TypeError('runTurn: argv must contain at least the binary name');
  }

  const child = spawn(bin, args, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    env: opts.env ?? process.env,
    windowsHide: true,
  });

  const clearTimers = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    if (killTimer) clearTimeout(killTimer);
    stallTimer = undefined;
    killTimer = undefined;
  };

  const hardKill = (): void => {
    killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, exitGraceMs);
    killTimer.unref?.();
  };

  const stop = (reason: 'cancel' | 'timeout'): void => {
    if (settled) return;
    if (reason === 'timeout') timedOut = true;
    else cancelled = true;
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    hardKill();
  };

  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) return;
    stallTimer = setTimeout(() => stop('timeout'), opts.timeoutMs);
    stallTimer.unref?.();
  };
  armStall();

  const consume = (line: string): void => {
    log.append(line);
    try {
      opts.parser.onLine(line, emit);
    } catch (err) {
      emit({ type: 'error', message: `parser failed on a line: ${errText(err)}` });
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    armStall();
    for (const line of splitter.push(chunk)) consume(line);
  });

  // Concurrent stderr drain. Capped, because some CLIs are extremely talkative.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    armStall();
    stderr += chunk;
    if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP);
  });

  child.stdin.on('error', () => {
    // The child may exit before reading the whole prompt (EPIPE). Not our problem.
  });
  child.stdin.end(opts.stdin);

  child.on('error', (err: NodeJS.ErrnoException) => {
    spawnError =
      err.code === 'ENOENT'
        ? `${bin} is not on your PATH. Install it, or run \`acr doctor\` to see what is detected.`
        : errText(err);
    finish(null, null);
  });

  child.on('close', (code, signal) => {
    for (const line of splitter.flush()) consume(line);
    finish(code, signal);
  });

  function finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (settled) return;
    settled = true;
    clearTimers();
    try {
      child.kill();
    } catch {
      // Already gone; kill() here is the belt to the `close` handler's braces.
    }
    try {
      opts.cleanup?.();
    } catch {
      // Cleanup is best effort.
    }

    let result: TurnResult;
    try {
      result = opts.parser.onExit(
        { exitCode: code, signal, stderr, cancelled, timedOut, spawnError },
        emit,
      );
    } catch (err) {
      result = {
        ok: false,
        text: '',
        exitCode: code,
        error: `parser failed at exit: ${errText(err)}`,
      };
    }

    // The parser only sees "the child died"; runTurn knows *why*, so it has the last word.
    if (timedOut) {
      result = {
        ...result,
        ok: false,
        timedOut: true,
        error: `turn produced no output for ${opts.timeoutMs}ms and was killed (stalled)`,
      };
    }
    if (cancelled) {
      result = { ...result, ok: false, cancelled: true, error: result.error ?? 'turn cancelled' };
    }

    if (!result.ok && result.error) {
      emit({ type: 'error', message: result.error, exitCode: code ?? undefined });
    }
    resolveDone(result);
  }

  return {
    turnId,
    cancel(_reason?: string) {
      stop('cancel');
    },
    done,
  };
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
