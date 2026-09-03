import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';
import { isLocalOrigin, isLoopbackHost } from '../src/security.js';
import { type Harness, harness, useTempConfigDir } from './helpers.js';

let config: ReturnType<typeof useTempConfigDir>;
let h: Harness;

beforeEach(async () => {
  config = useTempConfigDir();
  h = await harness();
});

afterEach(async () => {
  await h.close();
  config.restore();
});

describe('the origin check', () => {
  it('accepts every spelling of localhost and nothing else', () => {
    for (const origin of [
      'http://localhost:4321',
      'http://127.0.0.1:4321',
      'http://127.0.0.2:5173',
      'https://localhost',
      'http://[::1]:4321',
      'http://app.localhost:4321',
    ]) {
      expect(isLocalOrigin(origin), origin).toBe(true);
    }

    for (const origin of [
      'https://evil.example.com',
      'http://127.0.0.1.evil.com',
      'http://localhost.evil.com',
      'http://192.168.1.10:4321',
      'file:///tmp',
      // A sandboxed iframe sends this, and it is not a localhost page.
      'null',
      'not a url',
    ]) {
      expect(isLocalOrigin(origin), origin).toBe(false);
    }

    // No `Origin` at all is curl, the CLI or a test – none of which a web page can forge.
    expect(isLocalOrigin(undefined)).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
  });

  it('refuses a cross-origin REST call before it reaches a handler', async () => {
    const refused = await h.app.inject({
      url: '/api/rooms',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: string }>().error).toContain('cross-origin');

    // The dangerous ones specifically: one reads the filesystem, the other spawns an agent.
    const browse = await h.app.inject({
      url: '/api/repos/browse',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(browse.statusCode).toBe(403);

    const create = await h.app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { origin: 'https://evil.example.com' },
      payload: { task: 'rm -rf', cwd: '/', agents: ['echo', 'echo2'] },
    });
    expect(create.statusCode).toBe(403);

    const allowed = await h.app.inject({
      url: '/api/rooms',
      headers: { origin: 'http://localhost:4321' },
    });
    expect(allowed.statusCode).toBe(200);
  });
});

describe('startServer', () => {
  const started: { close(): Promise<void> }[] = [];

  afterEach(async () => {
    for (const s of started.splice(0)) await s.close();
  });

  it('binds loopback only, and walks the port when the one it wants is taken', async () => {
    // Port 0 first, so the test never fights whatever is already on this machine, then
    // deliberately ask for the port it just took.
    const first = await startServer({ store: h.store, webRoot: false, port: 0 });
    started.push(first);
    expect(first.url).toBe(`http://127.0.0.1:${first.port}`);

    const address = first.app.server.address();
    expect(typeof address === 'object' && address?.address).toBe('127.0.0.1');

    // Nothing listens on the network: PLAN.md section 7, "Public trust depends on it."
    expect(await (await fetch(`${first.url}/api/health`)).json()).toMatchObject({ ok: true });

    const second = await startServer({ store: h.store, webRoot: false, port: first.port });
    started.push(second);
    // Failing after `acr` has already opened a browser tab is worse than an odd port.
    expect(second.port).toBeGreaterThan(first.port);

    // Unless the caller says not to: `acr serve --port N` means that port.
    await expect(
      startServer({ store: h.store, webRoot: false, port: first.port, portAttempts: 0 }),
    ).rejects.toThrow(/EADDRINUSE/);
  });

  it('serves an explanation rather than a 404 when the web app is not built', async () => {
    const missing = `${config.dir}/no-such-build`;
    rmSync(missing, { recursive: true, force: true });
    const server = await startServer({ store: h.store, webRoot: missing, port: 0 });
    started.push(server);

    const page = await fetch(`${server.url}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('npm run build');

    // The API still 404s properly – a missing route is not a missing page.
    const api = await fetch(`${server.url}/api/nope`);
    expect(api.status).toBe(404);
  });
});
