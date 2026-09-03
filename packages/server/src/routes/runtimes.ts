import { gh, runtimeReport } from '@agent-chat-room/core';
import type { FastifyInstance } from 'fastify';

/**
 * The doctor page and the new-room dialog's roster, from the same function `acr doctor
 * --json` uses. Detection spawns nothing beyond `--version` and never reads a credential.
 */
export function runtimeRoutes(app: FastifyInstance): void {
  app.get('/api/runtimes', async () => {
    // `gh` rides along because "Open PR" is the one action that needs a tool the room
    // engine does not: the browser disables the button with a reason instead of failing
    // on click. Detected the same presence-only way, so it costs one `which` and a
    // `--version`.
    const [runtimes, ghDetection] = await Promise.all([runtimeReport(), gh.detectGh()]);
    return { node: process.version, runtimes, gh: ghDetection };
  });
}
