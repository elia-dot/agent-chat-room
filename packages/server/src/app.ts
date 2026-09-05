import { existsSync } from 'node:fs';

import { EngineError } from '@agent-chat-room/core';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { NotFoundError } from './errors.js';
import type { FolderPicker } from './picker.js';
import { repoRoutes } from './routes/repos.js';
import { roomRoutes } from './routes/rooms.js';
import { runtimeRoutes } from './routes/runtimes.js';
import { isAllowed, isLocalOrigin, validateCapabilityToken } from './security.js';
import { ConflictError, type RoomSupervisor } from './supervisor.js';
import { websocketRoute } from './ws.js';

export const SERVER_VERSION = '0.0.0';

/** The one API path the origin hook skips, because `verifyClient` guards it instead. */
export const WS_PATH = '/api/ws';

type VerifyNext = (ok: boolean, code?: number, message?: string) => void;

export interface CreateAppOptions {
  supervisor: RoomSupervisor;
  /** Directory holding the built web app. Omitted in tests. */
  webRoot?: string;
  /** The native folder dialog. Injected by tests, so no suite opens a window. */
  picker?: FolderPicker;
  logger?: boolean;
  /** Capability token for loopback authorization. */
  token?: string;
}

/**
 * The whole HTTP surface, as an un-listened Fastify instance.
 *
 * Returning the instance rather than a running server is what lets the tests drive every
 * route through `app.inject()` without opening a port – so the test suite stays hermetic
 * in the same way the rest of the project's is.
 */
export async function createApp(opts: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Otherwise `close()` waits for every keep-alive socket a browser is holding open, and
    // Ctrl-C on `acr` appears to hang.
    forceCloseConnections: true,
  });

  // One gate for the whole API. See `security.ts` for why localhost alone is not enough.
  // The WebSocket upgrade is refused by `verifyClient` below instead: answering an upgrade
  // with an ordinary 403 body leaves a socket that neither Node nor Fastify owns, and
  // `close()` then waits for it forever.
  app.addHook('onRequest', async (request, reply) => {
    const [path = '', query] = request.url.split('?');
    const searchParams = new URLSearchParams(query ?? '');
    const queryToken = searchParams.get('token');

    // Token redemption via redirect with HttpOnly cookie
    if (opts.token && queryToken && queryToken === opts.token) {
      searchParams.delete('token');
      const cleanQuery = searchParams.toString();
      const target = (path || '/') + (cleanQuery ? `?${cleanQuery}` : '');
      await reply
        .header(
          'Set-Cookie',
          `acr_token=${opts.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
        )
        .redirect(target);
      return;
    }

    if (path === WS_PATH) return;
    if (path.startsWith('/api/') && !isAllowed(request)) {
      await reply.status(403).send({ error: 'cross-origin request refused' });
      return;
    }

    const mutatingMethods = ['POST', 'PATCH', 'PUT', 'DELETE'];
    if (opts.token && path.startsWith('/api/') && mutatingMethods.includes(request.method)) {
      if (!validateCapabilityToken(request.headers, opts.token)) {
        await reply
          .status(401)
          .send({ error: 'unauthorized: missing or invalid capability token' });
        return;
      }
    }
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof NotFoundError) {
      await reply.status(404).send({ error: error.message });
      return;
    }
    if (error instanceof ConflictError) {
      await reply.status(409).send({ error: error.message });
      return;
    }
    if (error instanceof ZodError) {
      await reply.status(400).send({ error: describeZodError(error) });
      return;
    }
    // An `EngineError` is by definition something the human did or something about the
    // repo the engine will not guess at – a 400, not a 500.
    if (error instanceof EngineError) {
      await reply.status(400).send({ error: error.message });
      return;
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 0;
    const status = statusCode >= 400 ? statusCode : 500;
    await reply
      .status(status)
      .send({ error: error instanceof Error ? error.message : String(error) });
  });

  await app.register(websocket, {
    options: {
      verifyClient: (
        info: { origin?: string; req: { headers: Record<string, string | string[] | undefined> } },
        next: VerifyNext,
      ) => {
        if (!isLocalOrigin(info.origin || undefined)) {
          next(false, 403, 'cross-origin websocket refused');
          return;
        }
        if (opts.token && !validateCapabilityToken(info.req.headers, opts.token)) {
          next(false, 401, 'unauthorized: missing or invalid capability token');
          return;
        }
        next(true);
      },
    },
  });

  app.get('/api/health', () => ({ ok: true, version: SERVER_VERSION }));
  roomRoutes(app, opts.supervisor);
  runtimeRoutes(app);
  repoRoutes(app, opts.supervisor, opts.picker);
  websocketRoute(app, opts.supervisor);

  if (opts.webRoot) await serveWeb(app, opts.webRoot);
  return app;
}

/**
 * Serve the built web app, or explain why there isn't one.
 *
 * A 404 at the root after `acr` has just opened a browser tab is the least helpful thing
 * this server could do, so a missing build gets a page that says which command to run.
 */
async function serveWeb(app: FastifyInstance, webRoot: string): Promise<void> {
  if (!existsSync(`${webRoot}/index.html`)) {
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        await reply.status(404).send({ error: `no route for ${request.url}` });
        return;
      }
      await reply.type('text/html; charset=utf-8').send(MISSING_BUILD_PAGE);
    });
    return;
  }

  await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  // The web app owns its own routing, so any non-API path that is not a real file is the
  // app's to render, not a 404.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      await reply.status(404).send({ error: `no route for ${request.url}` });
      return;
    }
    await reply.sendFile('index.html');
  });
}

const MISSING_BUILD_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>agent-chat-room</title>
<style>
  body { font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; margin: 4rem auto; max-width: 34rem; padding: 0 1.5rem; }
  code { background: #f4f4f5; padding: 0.1em 0.35em; border-radius: 4px; }
</style>
<h1>The web app has not been built yet</h1>
<p>The server is running, but <code>packages/web/dist</code> is empty. Run
<code>npm run build</code> in the repo root and reload, or run <code>npm run dev:web</code>
for the Vite dev server on its own port.</p>
<p>The API is up either way: <a href="/api/health">/api/health</a>.</p>
`;

/** Zod's first issue, as a sentence – the whole error object is noise to a UI. */
function describeZodError(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid request';
  const where = issue.path.join('.');
  return where ? `${where}: ${issue.message}` : issue.message;
}
