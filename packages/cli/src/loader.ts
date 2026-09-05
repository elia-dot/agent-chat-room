/**
 * Module resolution hook for standalone package distribution.
 * When running from an npm-installed artifact (e.g. npx agent-chat-room),
 * packages are co-located under packages/core and packages/server.
 * If normal node_modules resolution fails to find @agent-chat-room/*,
 * this hook redirects to the co-located dist outputs.
 */
export async function resolve(
  specifier: string,
  context: { parentURL?: string; conditions: string[] },
  nextResolve: (
    specifier: string,
    context: { parentURL?: string; conditions: string[] },
  ) => Promise<{ url: string; format?: string; shortCircuit?: boolean }>,
): Promise<{ url: string; format?: string; shortCircuit?: boolean }> {
  try {
    return await nextResolve(specifier, context);
  } catch (err: unknown) {
    if (specifier === '@agent-chat-room/core') {
      return {
        url: new URL('../../core/dist/index.js', import.meta.url).href,
        shortCircuit: true,
      };
    }
    if (specifier.startsWith('@agent-chat-room/core/')) {
      const subpath = specifier.slice('@agent-chat-room/core/'.length);
      const file = subpath.endsWith('.js') ? subpath : `${subpath}.js`;
      return {
        url: new URL(`../../core/dist/${file}`, import.meta.url).href,
        shortCircuit: true,
      };
    }
    if (specifier === '@agent-chat-room/server') {
      return {
        url: new URL('../../server/dist/index.js', import.meta.url).href,
        shortCircuit: true,
      };
    }
    if (specifier.startsWith('@agent-chat-room/server/')) {
      const subpath = specifier.slice('@agent-chat-room/server/'.length);
      const file = subpath.endsWith('.js') ? subpath : `${subpath}.js`;
      return {
        url: new URL(`../../server/dist/${file}`, import.meta.url).href,
        shortCircuit: true,
      };
    }
    throw err;
  }
}
