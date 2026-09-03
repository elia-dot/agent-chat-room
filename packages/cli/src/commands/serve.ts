import { execFile } from 'node:child_process';

import type { RunningServer, ServerOptions } from '@agent-chat-room/server';
import { startServer as defaultStartServer } from '@agent-chat-room/server';

import { EXIT, type ExitCode } from '../exit.js';
import { Renderer } from '../render.js';

export interface ServeOptions {
  port?: number;
  /** Open the browser once the server is up. Default true. */
  open?: boolean;
  renderer?: Renderer;
  /** Injectable so `main.test.ts` never opens a port. */
  startServer?: (opts: ServerOptions) => Promise<RunningServer>;
  openBrowser?: (url: string) => void;
  /** Resolve as soon as the server is listening, instead of running until Ctrl-C. */
  detach?: boolean;
}

/**
 * `acr serve` – the web UI (PLAN.md section 5).
 *
 * The process stays in the foreground and holds the room engines, so a room the browser
 * started is running *here*: closing the tab does not stop it, but Ctrl-C does. That is the
 * "single Node process" shape from PLAN.md section 4, not an accident of implementation.
 */
export async function serve(opts: ServeOptions = {}): Promise<ExitCode> {
  const r = opts.renderer ?? new Renderer();
  const start = opts.startServer ?? defaultStartServer;

  const server = await start({
    ...(opts.port === undefined ? {} : { port: opts.port, portAttempts: 0 }),
  });

  r.info(`agent chat room is on ${server.url}`);
  r.info('nothing listens on the network: the server is bound to 127.0.0.1 only.');
  r.info('Ctrl-C to stop. Rooms keep running as long as this process does.');

  if (opts.open !== false) (opts.openBrowser ?? openBrowser)(server.url);
  if (opts.detach) return EXIT.ok;

  await waitForSignal(server, r);
  return EXIT.ok;
}

function waitForSignal(server: RunningServer, r: Renderer): Promise<void> {
  return new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = (): void => {
      if (closing) return;
      closing = true;
      r.info('stopping rooms and shutting down…');
      void server.close().then(resolve, resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

/** Best effort. A browser that will not open is a nuisance, not a failure. */
export function openBrowser(url: string): void {
  const opener: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? // The empty string is `start`'s window-title argument; without it a URL with
          // spaces in it becomes the title and nothing opens.
          ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  execFile(opener[0], opener[1], { windowsHide: true }, () => undefined);
}
