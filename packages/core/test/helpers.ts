import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// --- shared fixtures -------------------------------------------------------
// These live in `core` rather than in the CLI's test folder because the engine tests need
// them too, and the CLI helper re-exports them so its existing tests keep their imports.

/** A throwaway git repo with one committed file, for tests that need a real diff. */
export function makeRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'acr-repo-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'acr@example.test');
  git('config', 'user.name', 'acr test');
  git('config', 'commit.gpgsign', 'false');
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  git('add', '-A');
  git('commit', '-qm', 'initial');
  return dir;
}

/** Run git in a repo and return stdout. Tests assert on branches and commits with this. */
export function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

/**
 * Writes an echo-adapter script somewhere that is *not* the repo under test. Putting it in
 * the repo would make the working tree dirty, which `--no-worktree` correctly refuses.
 */
export function writeEchoScript(script: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'acr-script-'));
  const path = join(dir, 'echo-script.json');
  writeFileSync(path, JSON.stringify(script));
  return path;
}

/**
 * A disposable `ACR_CONFIG_DIR`, so the store, the worktrees and the locks a test creates
 * never touch the developer's real `~/.config/agent-chat-room`.
 */
export function useTempConfigDir(): { dir: string; restore: () => void } {
  const previous = process.env.ACR_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'acr-config-'));
  process.env.ACR_CONFIG_DIR = dir;
  return {
    dir,
    restore(): void {
      if (previous === undefined) delete process.env.ACR_CONFIG_DIR;
      else process.env.ACR_CONFIG_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Collects renderer output so a test can assert on the transcript. */
export class Capture {
  chunks: string[] = [];

  write = (chunk: string): void => {
    this.chunks.push(chunk);
  };

  get text(): string {
    return this.chunks.join('');
  }
}
