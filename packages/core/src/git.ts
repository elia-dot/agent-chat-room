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

/** Short sha for display. Returns undefined when `rev` does not resolve. */
export async function shortSha(cwd: string, rev = 'HEAD'): Promise<string | undefined> {
  const out = await gitOrUndefined(cwd, ['rev-parse', '--short', rev]);
  return out?.trim() || undefined;
}

/** True when `refs/heads/<name>` already exists. Used to keep room slugs unique. */
export async function branchExists(cwd: string, name: string): Promise<boolean> {
  const out = await gitOrUndefined(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
  return Boolean(out && out.trim().length > 0);
}

export interface WorktreeAddOptions {
  /** Create `branch` as part of the checkout. Off when the branch already exists. */
  createBranch?: boolean;
  /** Commit-ish the new branch starts from. Ignored when `createBranch` is false. */
  startPoint?: string;
}

/**
 * `git worktree add` – the isolation every room gets (PLAN.md section 7). The room's work
 * happens here, so the checkout the human is standing in is never touched.
 */
export async function worktreeAdd(
  cwd: string,
  path: string,
  branch: string,
  opts: WorktreeAddOptions = {},
): Promise<void> {
  const args = ['worktree', 'add'];
  if (opts.createBranch === false) {
    args.push(path, branch);
  } else {
    args.push('-b', branch, path);
    if (opts.startPoint) args.push(opts.startPoint);
  }
  await git(cwd, args);
}

/** Best effort: a worktree the user already deleted by hand must not break `acr rooms close`. */
export async function worktreeRemove(cwd: string, path: string): Promise<void> {
  await gitOrUndefined(cwd, ['worktree', 'remove', '--force', path]);
  await gitOrUndefined(cwd, ['worktree', 'prune']);
}

export async function worktreePrune(cwd: string): Promise<void> {
  await gitOrUndefined(cwd, ['worktree', 'prune']);
}

export interface CommitResult {
  ok: boolean;
  sha?: string;
  shortSha?: string;
  /** Set when there was simply nothing staged – an approved round with no edits. */
  empty?: boolean;
  error?: string;
}

/**
 * Stage everything in `cwd` and commit it. The engine commits after an approved round, so
 * a room's work is never sitting only in a working tree (PLAN.md section 7).
 *
 * Returns a result rather than throwing: "the repo has no committer identity configured"
 * is something the room has to render, not something that should take the process down.
 */
export async function commitAll(
  cwd: string,
  subject: string,
  body?: string,
): Promise<CommitResult> {
  try {
    await git(cwd, ['add', '-A']);
  } catch (err) {
    return { ok: false, error: errText(err) };
  }

  const staged = await gitOrUndefined(cwd, ['diff', '--cached', '--name-only']);
  if (!staged || staged.trim().length === 0) return { ok: false, empty: true };

  const args = ['commit', '-m', subject];
  if (body?.trim()) args.push('-m', body.trim());
  try {
    await git(cwd, args);
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
  const sha = await headSha(cwd);
  return { ok: true, sha, shortSha: await shortSha(cwd) };
}

/** The remotes this repo has, in `git remote` order. Empty when it has none. */
export async function remotes(cwd: string): Promise<string[]> {
  const out = await gitOrUndefined(cwd, ['remote']);
  return (out ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function remoteExists(cwd: string, name: string): Promise<boolean> {
  return (await remotes(cwd)).includes(name);
}

export interface PushResult {
  ok: boolean;
  remote: string;
  branch: string;
  error?: string;
}

/**
 * Push the room branch. This is the first thing in the project that leaves the machine, so
 * it never happens on its own: only `RoomEngine.openPr` calls it, only when the human
 * pressed the button, and the remote and branch it used land in the transcript.
 *
 * Returns a result rather than throwing – "the remote rejected it" is something the room
 * has to render, the same convention `commitAll` follows.
 */
export async function push(cwd: string, remote: string, branch: string): Promise<PushResult> {
  try {
    await git(cwd, ['push', '--set-upstream', remote, `${branch}:${branch}`]);
    return { ok: true, remote, branch };
  } catch (err) {
    return { ok: false, remote, branch, error: errText(err) };
  }
}

function errText(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
  return err instanceof Error ? err.message : String(err);
}
