import { execFile } from 'node:child_process';
import { join } from 'node:path';

import { credentialPresent, home, readVersion, which } from './detect.js';
import type { Detection } from './types.js';

/**
 * "Open PR" shells out to GitHub's own `gh`.
 *
 * The alternative is asking for a token, which the design rules out: spawning the
 * CLI the human already logged in with is the entire subscription mechanism, and it keeps
 * `acr` out of the credentials business for pull requests too. So `gh` is an optional
 * dependency – present and the button works, absent and the button says why.
 *
 * Detection follows `detect.ts` exactly: resolve the binary, read `--version`, and check
 * that a credentials file exists without ever opening it or spawning `gh auth status`.
 */
export const GH_BIN = 'gh';

export async function detectGh(): Promise<Detection> {
  const binPath = which(GH_BIN);
  if (!binPath) {
    return {
      installed: false,
      minVersionOk: false,
      note: '`gh` is not on your PATH. Install GitHub CLI to open pull requests from a room.',
    };
  }
  const version = await readVersion(binPath);
  const loggedIn = credentialPresent([
    join(configHome(), 'gh', 'hosts.yml'),
    join(home(), '.config', 'gh', 'hosts.yml'),
  ]);
  return {
    installed: true,
    binPath,
    version,
    // `gh` has no feature this project needs a floor for, so anything that runs is fine.
    minVersionOk: true,
    loggedIn,
    note: loggedIn === false ? 'run `gh auth login` first' : undefined,
  };
}

function configHome(): string {
  return process.env.XDG_CONFIG_HOME ?? join(home(), '.config');
}

export interface CreatePrInput {
  cwd: string;
  /** Branch the PR merges into – the branch the room's checkout was on. */
  base: string;
  /** The room branch, already pushed. */
  head: string;
  title: string;
  body?: string;
  draft?: boolean;
}

export interface CreatePrResult {
  ok: boolean;
  url?: string;
  error?: string;
}

/** The argv `createPr` runs. Split out so a test can pin it without spawning anything. */
export function buildCreatePrArgs(input: CreatePrInput): string[] {
  const args = ['pr', 'create', '--base', input.base, '--head', input.head, '--title', input.title];
  // `--body ''` is not the same as omitting it: `gh` opens an editor when neither `--body`
  // nor `--fill` is given, and a headless server has no editor to open.
  args.push('--body', input.body ?? '');
  if (input.draft) args.push('--draft');
  return args;
}

/** Runs a command and hands back what it printed. Injectable so tests never touch a network. */
export type GhRunner = (
  args: string[],
  cwd: string,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const execGh: GhRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      GH_BIN,
      args,
      { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 120_000 },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });

/**
 * `gh pr create`. Returns a result and never throws, so a room renders the failure instead
 * of the process dying on someone's expired login.
 */
export async function createPr(
  input: CreatePrInput,
  run: GhRunner = execGh,
): Promise<CreatePrResult> {
  const { code, stdout, stderr } = await run(buildCreatePrArgs(input), input.cwd);
  const url = firstUrl(stdout) ?? firstUrl(stderr);
  if (code === 0) {
    return url ? { ok: true, url } : { ok: true };
  }
  // `gh` answers "a pull request for branch X already exists: <url>" with a non-zero code.
  // That is not a failure the human needs to act on, so it comes back as the url it named.
  if (url && /already exists/i.test(stderr + stdout)) return { ok: true, url };
  const message = (stderr.trim() || stdout.trim() || `gh exited with code ${code ?? '?'}`)
    .split('\n')
    .slice(-5)
    .join('\n');
  return { ok: false, error: message };
}

function firstUrl(text: string): string | undefined {
  return /https:\/\/\S+/.exec(text)?.[0]?.replace(/[.,)\]]+$/, '');
}
