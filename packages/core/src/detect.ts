import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * Resolve a binary the way a shell would, without shelling out.
 *
 * `which` as a child process is one more spawn per detection and behaves differently on
 * Windows; walking `PATH` ourselves is both faster and portable.
 */
export function which(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (bin.includes('/') || bin.includes('\\')) {
    return isExecutable(bin) ? bin : undefined;
  }
  const pathVar = env.PATH ?? env.Path ?? '';
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];

  for (const dir of pathVar.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      if (isExecutable(candidate))
        return isAbsolute(candidate) ? candidate : join(process.cwd(), candidate);
    }
  }
  return undefined;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Presence-only login probe.
 *
 * We check that a credentials file exists and stop there. We never read the contents, and
 * we never spawn the CLI to ask – a detection pass must be free, and staying out of key
 * material is a promise the README makes.
 */
export function credentialPresent(candidates: string[]): boolean | undefined {
  let anyChecked = false;
  for (const p of candidates) {
    anyChecked = true;
    if (existsSync(p)) return true;
  }
  return anyChecked ? false : undefined;
}

export function home(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

/**
 * Run a CLI once, briefly, and hand back whatever it wrote. Never rejects and never runs
 * longer than `timeoutMs`: a probe that can hang is a probe that can hang the whole UI.
 *
 * The one spawn helper for every "ask the CLI a question" path – `readVersion` and the
 * model listing in `models.ts` both go through it.
 */
export async function readStdout(
  binPath: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const child = execFile(
      binPath,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout && !stderr) return resolve(undefined);
        resolve(`${stdout}\n${stderr}`);
      },
    );
    child.on('error', () => resolve(undefined));
  });
}

/** Run `<bin> --version` once, briefly, and pull a version out of whatever it prints. */
export async function readVersion(
  binPath: string,
  args: string[] = ['--version'],
  timeoutMs = 10_000,
): Promise<string | undefined> {
  const out = await readStdout(binPath, args, timeoutMs);
  if (out === undefined) return undefined;
  return extractVersion(out);
}

const VERSION_RE = /\b(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\b/;

export function extractVersion(text: string): string | undefined {
  const m = VERSION_RE.exec(text);
  return m ? m[0] : undefined;
}

/** Semver-ish comparison, tolerant of the `0.152.1` / `2026.07.23` shapes CLIs actually print. */
export function compareVersions(a: string, b: string): number {
  const pa = numericParts(a);
  const pb = numericParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function numericParts(v: string): number[] {
  return v
    .split(/[-+]/, 1)[0]!
    .split('.')
    .map((p) => Number.parseInt(p, 10))
    .map((n) => (Number.isNaN(n) ? 0 : n));
}

export function meetsMinVersion(version: string | undefined, min: string): boolean {
  if (!version) return false;
  return compareVersions(version, min) >= 0;
}
