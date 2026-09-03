/**
 * The CLI tests and the core engine tests need the same throwaway git repo and the same
 * echo script, so the fixtures live in `core`'s test helpers and this file re-exports
 * them. The vitest alias already resolves `@agent-chat-room/core` from source for both
 * projects, and `tsconfig.eslint.json` covers both `test` trees.
 */
export {
  Capture,
  gitIn,
  makeRepo,
  useTempConfigDir,
  writeEchoScript,
} from '../../core/test/helpers.js';
