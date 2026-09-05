#!/usr/bin/env node
import { register } from 'node:module';

try {
  register(new URL('./loader.js', import.meta.url), import.meta.url);
} catch (err) {
  if (process.env.DEBUG || process.env.ACR_DEBUG) {
    process.stderr.write(`acr: warning: failed to register module loader: ${String(err)}\n`);
  }
}

const { main } = await import('./main.js');

void main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `acr: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 1;
  });
