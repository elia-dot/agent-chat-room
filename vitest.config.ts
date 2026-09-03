import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests import `@agent-chat-room/core` by name but run straight from TypeScript
// source, so `npm test` never depends on a prior `npm run build`.
const coreSrc = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: { '@agent-chat-room/core': coreSrc } },
        test: {
          name: 'core',
          root: './packages/core',
          include: ['test/**/*.test.ts'],
          testTimeout: 20_000,
        },
      },
      {
        resolve: { alias: { '@agent-chat-room/core': coreSrc } },
        test: {
          name: 'cli',
          root: './packages/cli',
          include: ['test/**/*.test.ts'],
          testTimeout: 20_000,
        },
      },
      {
        resolve: { alias: { '@agent-chat-room/core': coreSrc } },
        test: {
          name: 'server',
          root: './packages/server',
          include: ['test/**/*.test.ts'],
          testTimeout: 20_000,
        },
      },
      {
        // Node, not jsdom: everything worth pinning in the web app – event reduction,
        // mention parsing, diff parsing – is a pure module, deliberately.
        resolve: { alias: { '@agent-chat-room/core': coreSrc } },
        test: {
          name: 'web',
          root: './packages/web',
          include: ['test/**/*.test.ts'],
          testTimeout: 20_000,
        },
      },
    ],
  },
});
