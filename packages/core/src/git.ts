import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  });
  return stdout;
}

async function gitOrUndefined(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

/**
 * Some git subcommands report "there is a difference" with exit code 1, which `execFile`
 * turns into a rejection. The stdout we want is still attached to the error.
 */
async function gitKeepingStdout(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    return typeof stdout === 'string' && stdout.length > 0 ? stdout : undefined;
  }
}

/** Absolute path of the repository containing `cwd`, or undefined when there is none. */
export async function repoRoot(cwd: string): Promise<string | undefined> {
  const out = await gitOrUndefined(cwd, ['rev-parse', '--show-toplevel']);
  return out?.trim() || undefined;
}

export async function headSha(cwd: string): Promise<string | undefined> {
  const out = await gitOrUndefined(cwd, ['rev-parse', 'HEAD']);
  return out?.trim() || undefined;
}

export async function currentBranch(cwd: string): Promise<string> {
  const out = await gitOrUndefined(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = out?.trim();
  return !name || name === 'HEAD' ? 'detached HEAD' : name;
}

/** Tracked modifications plus untracked files – the same thing `git status` calls dirty. */
export async function isDirty(cwd: string): Promise<boolean> {
  const out = await gitOrUndefined(cwd, ['status', '--porcelain']);
  return Boolean(out && out.trim().length > 0);
}

export async function diffStat(cwd: string, base?: string): Promise<string> {
  const args = base ? ['diff', '--stat', base] : ['diff', '--stat'];
  return (await gitOrUndefined(cwd, args))?.trim() ?? '';
}

/**
 * The diff a turn produced: tracked changes since `base`, plus untracked files rendered as
 * additions. Without the untracked half, a worker that creates a new file looks to the
 * reviewer like it did nothing at all.
 */
export async function diffSince(cwd: string, base?: string): Promise<string> {
  const args = base ? ['diff', base] : ['diff', 'HEAD'];
  let diff = (await gitOrUndefined(cwd, args)) ?? '';

  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  for (const path of await listUntracked(cwd)) {
    const added = await gitKeepingStdout(cwd, ['diff', '--no-index', '--', nullDevice, path]);
    // A binary or unreadable file yields no usable stdout; still say it exists rather than
    // letting a new file vanish from the reviewer's view.
    diff += added ?? `\ndiff --git a/${path} b/${path}\nnew file (contents not shown)\n`;
  }
  return diff;
}

export async function listUntracked(cwd: string): Promise<string[]> {
  const out = await gitOrUndefined(cwd, ['ls-files', '--others', '--exclude-standard']);
  return (out ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Paths touched since `base`, tracked and untracked, for the CLI's changed-files list. */
export async function changedFiles(cwd: string, base?: string): Promise<string[]> {
  const args = base ? ['diff', '--name-only', base] : ['diff', '--name-only', 'HEAD'];
  const tracked = ((await gitOrUndefined(cwd, args)) ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const untracked = await listUntracked(cwd);
  return [...new Set([...tracked, ...untracked])].sort();
}
