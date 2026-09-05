import { RoomStore } from '@agent-chat-room/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { serve } from '../src/commands/serve.js';
import { EXIT } from '../src/exit.js';
import { Renderer } from '../src/render.js';
import { Capture, useTempConfigDir } from './helpers.js';

let config: ReturnType<typeof useTempConfigDir>;
let store: RoomStore;
const running: { close(): Promise<void> }[] = [];

beforeEach(() => {
  config = useTempConfigDir();
  store = RoomStore.open(':memory:');
});

afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
  store.close();
  config.restore();
});

describe('acr serve', () => {
  it('starts a real localhost server, prints the URL it bound and opens it', async () => {
    const capture = new Capture();
    const opened: string[] = [];
    // `startServer` is real here; only the browser is faked, because a test that opens a
    // browser window is a test nobody runs twice.
    const { startServer } = await import('@agent-chat-room/server');

    const code = await serve({
      renderer: new Renderer({ color: false, write: capture.write }),
      detach: true,
      openBrowser: (url) => opened.push(url),
      startServer: async (opts) => {
        const server = await startServer({ ...opts, store, webRoot: false, port: 0 });
        running.push(server);
        return server;
      },
    });

    expect(code).toBe(EXIT.ok);
    expect(opened).toHaveLength(1);
    // The URL printed has to be the one actually bound, or a browser opens on nothing.
    // It carries the capability token, and the browser has to be handed that whole URL:
    // the token is what the one-time cookie redemption needs.
    const printed = /http:\/\/127\.0\.0\.1:\d+(?:\/\?token=\S+)?/.exec(capture.text)?.[0];
    const url = /http:\/\/127\.0\.0\.1:\d+/.exec(capture.text)?.[0];
    expect(url).toBeTruthy();
    expect(opened[0]).toBe(printed);
    expect(capture.text).toContain('127.0.0.1');

    const health = await fetch(`${url!}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
  });

  it('leaves the browser alone when told to', async () => {
    const opened: string[] = [];
    const { startServer } = await import('@agent-chat-room/server');
    await serve({
      renderer: new Renderer({ color: false, write: new Capture().write }),
      detach: true,
      open: false,
      openBrowser: (url) => opened.push(url),
      startServer: async (opts) => {
        const server = await startServer({ ...opts, store, webRoot: false, port: 0 });
        running.push(server);
        return server;
      },
    });
    expect(opened).toEqual([]);
  });
});
