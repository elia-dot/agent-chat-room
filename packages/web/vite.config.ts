import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

function getDevToken(): string | undefined {
  try {
    const configDir = process.env.ACR_CONFIG_DIR ?? join(homedir(), '.config', 'agent-chat-room');
    const tokenPath = join(configDir, 'server.token');
    if (existsSync(tokenPath)) {
      return readFileSync(tokenPath, 'utf8').trim();
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * The web app is bundled by Vite, not by `tsc -b`, so it is the one package with its own
 * build. `@agent-chat-room/core` is aliased to source: the app only ever imports *types*
 * from it (`verbatimModuleSyntax` erases those), so aliasing costs nothing at runtime and
 * keeps `better-sqlite3` a thousand miles from the bundle.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@agent-chat-room/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // `npm run dev:web` talks to `npm run dev:server`, so the two can reload separately.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4321',
        ws: true,
        changeOrigin: false,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            const token = getDevToken();
            if (token && !proxyReq.getHeader('authorization') && !proxyReq.getHeader('cookie')) {
              proxyReq.setHeader('authorization', `Bearer ${token}`);
            }
          });
          proxy.on('proxyReqWs', (proxyReq) => {
            const token = getDevToken();
            if (token && !proxyReq.getHeader('authorization') && !proxyReq.getHeader('cookie')) {
              proxyReq.setHeader('authorization', `Bearer ${token}`);
            }
          });
        },
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
});
