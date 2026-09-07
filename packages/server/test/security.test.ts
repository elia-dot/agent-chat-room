import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';
import { isLocalHost, isLocalOrigin, isLoopbackHost } from '../src/security.js';
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

  it('refuses a request addressed to a name that is not loopback', async () => {
    // DNS rebinding: a page on evil.example whose name now resolves to 127.0.0.1 makes a
    // same-origin GET, which carries no Origin header at all. Host still says evil.example.
    for (const host of ['evil.example:4321', '192.168.1.10:4321', '127.0.0.1.evil.com']) {
      expect(isLocalHost(host), host).toBe(false);
      const rebound = await h.app.inject({ url: '/api/rooms', headers: { host } });
      expect(rebound.statusCode, host).toBe(403);
    }
    for (const host of ['localhost:4321', '127.0.0.1:4321', '[::1]:4321', 'localhost']) {
      expect(isLocalHost(host), host).toBe(true);
    }
    expect(isLocalHost(undefined)).toBe(false);
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

    // Nothing listens on the network beyond loopback; public trust depends on it.
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
    const server = await startServer({
      store: h.store,
      webRoot: missing,
      port: 0,
      token: 'test-token-123',
    });
    started.push(server);

    const page = await fetch(`${server.url}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('npm run build');

    // The API still 404s properly – a missing route is not a missing page. Asked *with* the
    // token, because auth runs first: an unauthenticated caller gets 401 for every route,
    // which is deliberate. Answering 404 for the routes that do not exist and 401 for the
    // ones that do would hand an anonymous prober the route table.
    const api = await fetch(`${server.url}/api/nope`, {
      headers: { Authorization: 'Bearer test-token-123' },
    });
    expect(api.status).toBe(404);

    // And without it, the same route is refused rather than described.
    const anonymous = await fetch(`${server.url}/api/nope`);
    expect(anonymous.status).toBe(401);
  });

  it('generates a capability token, redeems via cookie, and guards mutating endpoints', async () => {
    const server = await startServer({
      store: h.store,
      webRoot: false,
      port: 0,
      token: 'test-token-123',
    });
    started.push(server);

    // 1. GET /?token=test-token-123 redeems cookie and redirects
    const redeemRes = await fetch(`${server.url}/?token=test-token-123`, { redirect: 'manual' });
    expect([301, 302, 303, 307, 308]).toContain(redeemRes.status);
    const setCookie = redeemRes.headers.get('set-cookie');
    expect(setCookie).toContain('acr_token=test-token-123');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Max-Age=2592000');

    // 1b. Reads need the token as much as writes: a transcript is as private as the room.
    // Only the health probe is open, so a script can ask whether the server is up.
    const unauthGet = await fetch(`${server.url}/api/rooms`);
    expect(unauthGet.status).toBe(401);
    const health = await fetch(`${server.url}/api/health`);
    expect(health.status).toBe(200);
    const authGet = await fetch(`${server.url}/api/rooms`, {
      headers: { Cookie: 'acr_token=test-token-123' },
    });
    expect(authGet.status).toBe(200);

    // 2. Mutating API call without token is rejected with 401
    const unauthPost = await fetch(`${server.url}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'foo', cwd: '/', agents: ['echo', 'echo2'] }),
    });
    expect(unauthPost.status).toBe(401);
    const unauthBody = (await unauthPost.json()) as { error?: string };
    expect(unauthBody.error).toContain('unauthorized');

    // 3. Mutating API call with token via header succeeds past auth
    // (can hit validation or 400, not 401)
    const authHeaderPost = await fetch(`${server.url}/api/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token-123',
      },
      body: JSON.stringify({ task: 'foo', cwd: '/', agents: ['echo', 'echo2'] }),
    });
    expect(authHeaderPost.status).not.toBe(401);

    // 4. Mutating API call with cookie succeeds past auth
    const authCookiePost = await fetch(`${server.url}/api/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'acr_token=test-token-123',
      },
      body: JSON.stringify({ task: 'foo', cwd: '/', agents: ['echo', 'echo2'] }),
    });
    expect(authCookiePost.status).not.toBe(401);
  });

  it('redeems `?token=` in constant time, and only on a loopback host', async () => {
    const server = await startServer({
      store: h.store,
      webRoot: false,
      port: 0,
      token: 'test-token-123',
    });
    started.push(server);

    // A wrong token of the same length is refused, and so is one of a different length –
    // the length check is what lets `timingSafeEqual` be called at all.
    for (const wrong of ['test-token-124', 'nope']) {
      const res = await fetch(`${server.url}/?token=${wrong}`, { redirect: 'manual' });
      expect(res.headers.get('set-cookie')).toBeNull();
    }

    // The right one still redeems, so the guard has not simply broken redemption.
    const ok = await fetch(`${server.url}/?token=test-token-123`, { redirect: 'manual' });
    expect(ok.headers.get('set-cookie')).toContain('acr_token=test-token-123');

    // This hands out a cookie, so it must not be reachable on a request claiming to have
    // arrived at some other name – the shape a DNS-rebinding attempt has. Injected rather
    // than fetched: `Host` is a forbidden header for `fetch`, which drops it silently, so a
    // fetch-based version of this assertion would pass without testing anything.
    const rebound = await server.app.inject({
      method: 'GET',
      url: '/?token=test-token-123',
      headers: { host: 'evil.example.com' },
    });
    expect(rebound.headers['set-cookie']).toBeUndefined();

    // The same request on a loopback host does redeem, so the guard is the host and not
    // some accident of injection.
    const injected = await server.app.inject({
      method: 'GET',
      url: '/?token=test-token-123',
      headers: { host: '127.0.0.1:4321' },
    });
    expect(String(injected.headers['set-cookie'])).toContain('acr_token=test-token-123');
  });
});
