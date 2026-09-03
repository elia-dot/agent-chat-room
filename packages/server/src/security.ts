import type { FastifyRequest } from 'fastify';

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

/** True when this request may touch the API. */
export function isAllowed(request: Pick<FastifyRequest, 'headers'>): boolean {
  const origin = request.headers.origin;
  return isLocalOrigin(typeof origin === 'string' ? origin : undefined);
}
