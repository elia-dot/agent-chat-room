import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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

/** Which branch a room starts from, and how confidently that was decided. */
export interface BaseBranchChoice {
  branch: string;
  /**
   * `remote` is the remote's own answer and `conventional` is a local `main`/`master`;
   * both are the repository telling us. `checkout` is the last resort: nothing said which
   * branch is the trunk, so the one that happened to be open was taken. That is right in a
   * repository whose only branch is the one you are on, and wrong in one whose trunk is
   * called `develop` while you stand on a feature branch – so callers say it out loud
   * rather than letting a room quietly base itself on a guess.
   */
  source: 'remote' | 'conventional' | 'checkout';
}

/**
 * The branch rooms are cut from: what `origin/HEAD` points at when the remote says, else
 * `main` or `master` when one exists locally, else the branch that is checked out.
 *
 * A repository is not required to call its trunk `main`. Guessing wrong here would send
 * every room of a `master` repository to a branch that does not exist, so the remote's
 * own answer is preferred and the two conventional names are only a fallback.
 */
export async function defaultBranch(cwd: string): Promise<BaseBranchChoice> {
  const advertised = (
    await gitOrUndefined(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  )?.trim();
  if (advertised) {
    const name = advertised.replace(/^origin\//, '');
    if (await branchExists(cwd, name)) return { branch: name, source: 'remote' };
  }
  for (const name of ['main', 'master']) {
    if (await branchExists(cwd, name)) return { branch: name, source: 'conventional' };
  }
  const current = await currentBranch(cwd);
  if (current !== 'detached HEAD') return { branch: current, source: 'checkout' };
  throw new Error(
    'could not tell which branch this repository starts from: no origin/HEAD, no main or ' +
      'master, and HEAD is detached',
  );
}

/**
 * The newest fast-forward-compatible commit on `branch`, the repository's base branch.
 *
 * A room must not inherit whichever feature branch happened to be checked out when it was
 * opened. Fetching into the remote-tracking ref gives it the result of an up-to-date base
 * without switching or modifying the human's checkout. Local commits already ahead of the
 * remote are preserved, just as they would be by `git pull --ff-only`.
 */
export async function freshBaseSha(cwd: string, branch: string): Promise<string> {
  const local = (
    await gitOrUndefined(cwd, ['rev-parse', '--verify', `refs/heads/${branch}`])
  )?.trim();
  if (!local) throw new Error(`this repository has no local ${branch} branch`);

  if (!(await remoteExists(cwd, 'origin'))) return local;

  try {
    // A newly configured, still-empty forge remote has nothing to pull yet. That is not a
    // stale-base condition: the local branch is necessarily the only available start.
    const ref = `refs/heads/${branch}`;
    const advertised = await git(cwd, ['ls-remote', '--heads', 'origin', ref]);
    if (!advertised.trim()) return local;
    await git(cwd, ['fetch', 'origin', `+${ref}:refs/remotes/origin/${branch}`]);
  } catch (err) {
    throw new Error(`could not update ${branch} from origin: ${errText(err)}`);
  }

  const remote = (
    await gitOrUndefined(cwd, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`])
  )?.trim();
  if (!remote) throw new Error(`origin has no ${branch} branch`);
  if (await isAncestor(cwd, local, remote)) return remote;
  if (await isAncestor(cwd, remote, local)) return local;
  throw new Error(
    `local ${branch} has diverged from origin/${branch}; reconcile it before opening a room`,
  );
}

/** `freshBaseSha` for a repository whose base branch is `main`. */
export function freshMainSha(cwd: string): Promise<string> {
  return freshBaseSha(cwd, 'main');
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
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

/**
 * Restore tracked files to their `HEAD` content – how the room undoes an edit an agent
 * made in a folder it was only granted read access to. Untracked files are the caller's
 * problem: `checkout` has nothing to restore them from.
 */
export async function checkoutPaths(cwd: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  await gitOrUndefined(cwd, ['checkout', 'HEAD', '--', ...paths]);
}

/**
 * Create `name` and switch to it, carrying the working tree across. Starts at HEAD unless
 * `startPoint` names something else.
 *
 * A room repo gets a worktree; an additional folder is the human's own checkout, so the
 * only way to give its commits somewhere of their own to live is to branch in place. A
 * room that opted out of a worktree branches in place too, and passes the freshly fetched
 * base as `startPoint` so it does not inherit whichever branch you were standing on.
 */
export async function checkoutNewBranch(
  cwd: string,
  name: string,
  startPoint?: string,
): Promise<void> {
  await git(cwd, ['checkout', '-b', name, ...(startPoint ? [startPoint] : [])]);
}

/** How many commits `head` has that `base` does not. Zero when either ref does not resolve. */
export async function aheadCount(cwd: string, base: string, head: string): Promise<number> {
  const out = await gitOrUndefined(cwd, ['rev-list', '--count', `${base}..${head}`]);
  return Number(out?.trim()) || 0;
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

export interface MergeResult {
  ok: boolean;
  /** `into` already contained every commit on `branch`, so nothing was written. */
  alreadyUpToDate?: boolean;
  sha?: string;
  shortSha?: string;
  error?: string;
}

/**
 * Merge `branch` into the branch `cwd` is standing on.
 *
 * This is the one thing in the project that writes to the human's own checkout, which is
 * exactly why the worktree design avoided it for so long (PLAN.md section 10). So it is
 * deliberately unhelpful: it refuses unless the checkout is already on `into`, clean, and
 * not part-way through an operation of its own, rather than switching branches or stashing
 * on someone's behalf, and a merge *it started* that conflicts is aborted rather than left
 * half-applied for them to discover.
 *
 * `--no-ff` is not a style preference: a room's rounds are a unit of work, and a merge
 * commit is what keeps them attributable to the room after the branch is gone.
 */
export async function mergeBranch(
  cwd: string,
  branch: string,
  opts: { into: string; message?: string },
): Promise<MergeResult> {
  const standingOn = await currentBranch(cwd);
  if (standingOn !== opts.into) {
    return {
      ok: false,
      error: `${cwd} is on ${standingOn}, not ${opts.into}. Check out ${opts.into} there and try again.`,
    };
  }
  // Before the dirty check, because it is the case the dirty check cannot see: resolve a
  // conflict to match HEAD and `git status --porcelain` goes quiet while MERGE_HEAD is
  // still sitting there. Starting here would fail, and the failure path would then abort
  // the human's merge, not ours.
  const pending = await pendingOperation(cwd);
  if (pending) {
    return {
      ok: false,
      error: `${cwd} is part-way through a ${pending}. Finish or abort it before merging into ${opts.into}.`,
    };
  }
  if (await isDirty(cwd)) {
    return {
      ok: false,
      error: `${cwd} has uncommitted changes. Commit or stash them before merging into ${opts.into}.`,
    };
  }
  if (!(await branchExists(cwd, branch))) {
    return { ok: false, error: `${cwd} has no branch called ${branch}` };
  }
  if ((await aheadCount(cwd, opts.into, branch)) === 0) {
    return { ok: true, alreadyUpToDate: true };
  }

  const message = opts.message?.trim() || `Merge ${branch}`;
  try {
    await git(cwd, ['merge', '--no-ff', '-m', message, branch]);
  } catch (err) {
    // A conflicted merge leaves the index half-applied. Undo it: the human asked for a
    // merge, not for a repository to be handed back mid-conflict by a background process.
    //
    // Only when the merge state is ours, though. There was none when we checked above and
    // the caller holds the repo write lock throughout, so merge state here was created by
    // the command that just failed. A failure that left none – a bad ref, an unreadable
    // object – has nothing to abort, and `--abort` is not a general-purpose undo.
    if ((await pendingOperation(cwd)) === 'merge') {
      await gitOrUndefined(cwd, ['merge', '--abort']);
    }
    return { ok: false, error: errText(err) };
  }
  return { ok: true, sha: await headSha(cwd), shortSha: await shortSha(cwd) };
}

/**
 * Which multi-step operation `cwd` is part-way through, if any.
 *
 * Not the same question as `isDirty`: git records these as pseudo-refs and state
 * directories, and a working tree can be perfectly clean while one is open.
 */
export async function pendingOperation(
  cwd: string,
): Promise<'merge' | 'cherry-pick' | 'revert' | 'rebase' | undefined> {
  const refs = [
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
  ] as const;
  for (const [ref, name] of refs) {
    const out = await gitOrUndefined(cwd, ['rev-parse', '--verify', '--quiet', ref]);
    if (out?.trim()) return name;
  }
  // A rebase has no pseudo-ref of its own until it stops; the state directory is what is
  // there for the whole run. `--git-path` resolves it for worktrees and `$GIT_DIR` alike.
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    const path = (await gitOrUndefined(cwd, ['rev-parse', '--git-path', dir]))?.trim();
    if (path && existsSync(resolve(cwd, path))) return 'rebase';
  }
  return undefined;
}

function errText(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
  return err instanceof Error ? err.message : String(err);
}
