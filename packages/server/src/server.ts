import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { RoomStore } from '@agent-chat-room/core';
import type { FastifyInstance } from 'fastify';

import { createApp } from './app.js';
import { getOrCreateServerToken } from './security.js';
import { RoomSupervisor } from './supervisor.js';

export const DEFAULT_PORT = 4321;

/** Loopback only. PLAN.md section 7: "Local only... Public trust depends on it." */
export const HOST = '127.0.0.1';

export interface ServerOptions {
  port?: number;
  /** Defaults to the shared `~/.config/agent-chat-room/acr.db`. */
  store?: RoomStore;
  /** Defaults to `packages/web/dist` next to this package. */
  webRoot?: string | false;
  logger?: boolean;
  /**
   * How many ports to try after `port` when it is taken. `0` fails instead of walking,
   * which is what an explicit `--port` wants: silently binding a different one would be a
   * surprise for anything that hard-coded the URL.
   */
  portAttempts?: number;
  /** Capability token for API authorization. Pass `false` to disable. */
  token?: string | false;
}

export interface RunningServer {
  url: string;
  port: number;
  token?: string;
  urlWithToken?: string;
  app: FastifyInstance;
  supervisor: RoomSupervisor;
  close(): Promise<void>;
}

/**
 * Start the server on localhost.
 *
 * The port walks upward when 4321 is taken, because the alternative – failing after `acr`
 * has already opened a browser tab – is worse than an unexpected port, and the URL that
 * was actually bound is what gets returned and printed.
 */
export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const store = opts.store ?? new RoomStore();
  const ownsStore = opts.store === undefined;
  const supervisor = new RoomSupervisor({ store });
  const webRoot = opts.webRoot === false ? undefined : (opts.webRoot ?? defaultWebRoot());
  const token =
    opts.token === false
      ? undefined
      : getOrCreateServerToken(typeof opts.token === 'string' ? opts.token : undefined);

  const app = await createApp({
    supervisor,
    ...(webRoot ? { webRoot } : {}),
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
    ...(token ? { token } : {}),
  });

  const attempts = opts.portAttempts ?? 10;
  let wanted = opts.port ?? DEFAULT_PORT;
  for (let i = 0; ; i += 1) {
    try {
      await app.listen({ host: HOST, port: wanted });
      break;
    } catch (err) {
      if (!isAddressInUse(err) || i >= attempts) {
        await app.close();
        if (ownsStore) store.close();
        throw err;
      }
      wanted += 1;
    }
  }

  // Never the port that was asked for: with `port: 0` the OS picks, and after a walk the
  // number that matters is the one actually bound. Opening a browser at the wrong one is
  // the failure this avoids.
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : wanted;
  const url = `http://${HOST}:${port}`;

  return {
    url,
    port,
    ...(token ? { token, urlWithToken: `${url}/?token=${token}` } : {}),
    app,
    supervisor,
    async close(): Promise<void> {
      await supervisor.shutdown();
      await app.close();
      if (ownsStore) store.close();
    },
  };
}

function isAddressInUse(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE';
}

/**
 * `packages/web/dist`, relative to this file in both layouts it can run from: `dist/` in a
 * build, `src/` under vite-node or a test, or `./web` in the distributed package.
 */
export function defaultWebRoot(): string {
  const candidates = ['../../web/dist', '../../../packages/web/dist', './web', '../web'];
  for (const rel of candidates) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(p)) return p;
  }
  return fileURLToPath(new URL('../../web/dist', import.meta.url));
}
