import { runtimeReport } from '@agent-chat-room/core';
import type { FastifyInstance } from 'fastify';

/**
 * The doctor page and the new-room dialog's roster, from the same function `acr doctor
 * --json` uses. Detection spawns nothing beyond `--version` and never reads a credential.
 */
export function runtimeRoutes(app: FastifyInstance): void {
  app.get('/api/runtimes', async () => ({
    node: process.version,
    runtimes: await runtimeReport(),
  }));
}
