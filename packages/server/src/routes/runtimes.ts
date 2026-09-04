import { gh, listAllModels, listModels, runtimeReport } from '@agent-chat-room/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const ModelsQuery = z.object({ runtime: z.string().min(1).optional() });

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

  /**
   * What you are allowed to type in the model box, per runtime – a separate route from
   * `/api/runtimes` on purpose: detection must stay free (`--version`, no network) and
   * this one is not. `cursor-agent --list-models` reaches Cursor's API, so folding the two
   * together would make the doctor page pay for that call. `listAllModels` caches, so the
   * dialog asking on every open costs one spawn every five minutes.
   */
  app.get('/api/runtimes/models', async (request) => {
    const { runtime } = ModelsQuery.parse(request.query);
    const catalogs = runtime ? [await listModels(runtime)] : await listAllModels();
    return { catalogs };
  });
}
