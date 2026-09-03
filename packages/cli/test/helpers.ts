import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A throwaway git repo with one committed file, for tests that need a real diff. */
export function makeRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'acr-repo-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  };
  git('init', '-q');
  git('config', 'user.email', 'acr@example.test');
  git('config', 'user.name', 'acr test');
  git('config', 'commit.gpgsign', 'false');
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  git('add', '-A');
  git('commit', '-qm', 'initial');
  return dir;
}

/**
 * Writes an echo-adapter script somewhere that is *not* the repo under test. Putting it in
 * the repo would make the working tree dirty, which `acr run` correctly refuses to touch.
 */
export function writeEchoScript(script: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'acr-script-'));
  const path = join(dir, 'echo-script.json');
  writeFileSync(path, JSON.stringify(script));
  return path;
}

/** Collects renderer output so a test can assert on the transcript. */
export class Capture {
  chunks: string[] = [];

  write = (chunk: string): void => {
    this.chunks.push(chunk);
  };

  get text(): string {
    return this.chunks.join('');
  }
}
