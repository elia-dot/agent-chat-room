import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { serverTokenPath } from '@agent-chat-room/core';
import type { FastifyRequest } from 'fastify';

/**
 * Generate or read the capability token at ~/.config/agent-chat-room/server.token with mode 0600.
 */
export function getOrCreateServerToken(token?: string): string {
  if (token && token.trim()) return token.trim();
  const path = serverTokenPath();
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
  } catch {
    // If read fails, generate a new token
  }
  mkdirSync(dirname(path), { recursive: true });
  const generated = randomBytes(32).toString('hex');
  writeFileSync(path, generated + '\n', { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows does not support 0600 chmod
  }
  return generated;
}

/**
 * Localhost is not a security boundary on its own.
 *
 * `GET /api/repos/browse` reads arbitrary directories and `POST /api/rooms` spawns an agent
 * CLI with `edits` permission. Any page you happen to have open can POST to
 * `127.0.0.1:4321`, and DNS rebinding gets it a same-origin read too. Checking `Origin` is
 * what makes PLAN.md section 7's "nothing listens on the network" promise actually hold, so
 * it is a required part of the server rather than a hardening extra.
 *
 * A request with no `Origin` at all is allowed: that is `curl`, the CLI and the test suite,
 * none of which a web page can forge – a browser always sends `Origin` on a cross-origin
 * request, and on a same-origin one it either sends it or the request is a plain navigation.
 */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin === 'null') return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return isLoopbackHost(url.hostname);
}

/** `localhost`, IPv4 loopback, and the bracketed IPv6 form `new URL` hands back. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * The `Host` a request was addressed to, checked the same way as `Origin`.
 *
 * `Origin` alone does not stop DNS rebinding: a page on `evil.example` whose name is
 * re-pointed at 127.0.0.1 makes *same-origin* requests to this server, and a same-origin
 * GET carries no `Origin` at all. What it cannot fake is `Host`, which still says
 * `evil.example` – so a request addressed to any name other than loopback is refused.
 */
export function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  // `[::1]:4321`, `127.0.0.1:4321`, `localhost` – strip a port without breaking IPv6.
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.replace(/:\d+$/, '');
  return isLoopbackHost(hostname);
}

/** True when this request may touch the API. */
export function isAllowed(request: Pick<FastifyRequest, 'headers'>): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  return (
    isLocalHost(typeof host === 'string' ? host : undefined) &&
    isLocalOrigin(typeof origin === 'string' ? origin : undefined)
  );
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

export function extractToken(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  const xToken = headers['x-acr-token'];
  if (typeof xToken === 'string') {
    return xToken.trim();
  }
  const cookie = typeof headers.cookie === 'string' ? headers.cookie : undefined;
  const parsed = parseCookies(cookie);
  if (parsed.acr_token) {
    return parsed.acr_token;
  }
  return undefined;
}

export function validateCapabilityToken(
  headers: Record<string, string | string[] | undefined>,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) return true;
  const provided = extractToken(headers);
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedToken);
  return a.length === b.length && timingSafeEqual(a, b);
}
