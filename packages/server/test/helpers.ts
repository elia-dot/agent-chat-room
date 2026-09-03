import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentAdapter } from '@agent-chat-room/core';
import { RoomStore, echoAdapter, resetEchoAdapter } from '@agent-chat-room/core';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../src/app.js';
import { RoomSupervisor } from '../src/supervisor.js';

/** A throwaway git repo with one committed file, so a room has something real to diff. */
export function makeRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'acr-srv-repo-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'acr@example.test');
  git('config', 'user.name', 'acr test');
  git('config', 'commit.gpgsign', 'false');
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  git('add', '-A');
  git('commit', '-qm', 'initial');
  return dir;
}

/** A disposable `ACR_CONFIG_DIR`, so a test never touches the developer's real state. */
export function useTempConfigDir(): { dir: string; restore: () => void } {
  const previous = process.env.ACR_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'acr-srv-config-'));
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

export function writeEchoScript(turns: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'acr-srv-script-'));
  const path = join(dir, 'echo-script.json');
  writeFileSync(path, JSON.stringify({ turns }));
  process.env.ACR_ECHO_SCRIPT = path;
  resetEchoAdapter();
  return path;
}

/** A second runtime id backed by the same double, so a roster has two distinct names. */
export const echo2: AgentAdapter = {
  ...echoAdapter,
  id: 'echo2',
  run: (req, sink) => echoAdapter.run(req, sink),
};

export const testAdapters: Record<string, AgentAdapter> = { echo: echoAdapter, echo2 };

export interface Harness {
  app: FastifyInstance;
  store: RoomStore;
  supervisor: RoomSupervisor;
  close(): Promise<void>;
}

/** An app over an in-memory database and the echo adapter. No port, no network. */
export async function harness(
  opts: { coalesceMs?: number; webRoot?: string } = {},
): Promise<Harness> {
  const store = RoomStore.open(':memory:');
  const supervisor = new RoomSupervisor({
    store,
    engine: { adapters: testAdapters, timeoutMs: 5000 },
    coalesceMs: opts.coalesceMs ?? 0,
    notify: false,
  });
  const app = await createApp({
    supervisor,
    ...(opts.webRoot ? { webRoot: opts.webRoot } : {}),
  });
  return {
    app,
    store,
    supervisor,
    async close(): Promise<void> {
      await supervisor.shutdown();
      await app.close();
      store.close();
    },
  };
}

export const verdict = (decision: string, blocking: string[] = []): string =>
  `Review body.\n\n\`\`\`verdict\n${JSON.stringify({ decision, blocking, nits: [] })}\n\`\`\``;

/** Poll until `check` passes, so a test never sleeps a fixed amount for a background run. */
export async function waitFor(
  check: () => boolean,
  message = 'condition',
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
