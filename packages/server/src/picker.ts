import { execFile } from 'node:child_process';

import { which } from '@agent-chat-room/core';

import { ConflictError } from './supervisor.js';

/**
 * The native folder picker, opened by the server process.
 *
 * A browser cannot hand back an absolute path – `showDirectoryPicker()` is Chromium-only
 * and returns an opaque handle, `<input webkitdirectory>` returns relative names – but a
 * room needs an absolute `cwd` on the machine that will spawn the agent CLIs. That machine
 * is this process: `acr serve` binds `127.0.0.1` and already shells out to `osascript` in
 * `notify.ts`. So the browser asks the server to open a dialog and gets a path back.
 *
 * Shaped like `notify.ts` – a platform option and an injectable runner – so the test suite
 * never opens a window.
 */
export type PickerTool = 'osascript' | 'powershell' | 'zenity' | 'kdialog';

export interface RunResult {
  code: number;
  stdout: string;
}

/** Runs the dialog binary. Rejects when the process could not be spawned at all. */
export type PickerRun = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<RunResult | { timedOut: true }>;

export interface PickerOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: PickerRun;
  /** Where the dialog opens. Ignored by the tools that cannot honour it. */
  startPath?: string;
  timeoutMs?: number;
}

export interface PickerAvailability {
  available: boolean;
  tool: PickerTool | null;
}

/** Either the human chose a directory, or they dismissed the dialog. */
export type PickResult = { path: string } | { cancelled: true };

export type FolderPicker = {
  available(opts?: PickerOptions): PickerAvailability;
  pick(opts?: PickerOptions): Promise<PickResult>;
};

/**
 * A dialog left open for two minutes is a dialog nobody is looking at, and its child
 * process would otherwise hold the single-flight lock for the life of the server.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The AppleScript is a constant. The start directory arrives through `on run argv`, so a
 * directory name containing a quote or a newline can never be parsed as script text.
 * `activate` first, because the dialog otherwise opens behind the browser window.
 */
const APPLESCRIPT = [
  'on run argv',
  '\ttell application "System Events" to activate',
  '\tset startPath to ""',
  '\tif (count of argv) > 0 then set startPath to item 1 of argv',
  '\ttry',
  '\t\tif startPath is not "" then',
  '\t\t\ttry',
  '\t\t\t\tset target to (POSIX file startPath) as alias',
  '\t\t\t\tset chosen to choose folder with prompt "Choose a project folder" default location target',
  '\t\t\ton error',
  '\t\t\t\tset chosen to choose folder with prompt "Choose a project folder"',
  '\t\t\tend try',
  '\t\telse',
  '\t\t\tset chosen to choose folder with prompt "Choose a project folder"',
  '\t\tend if',
  '\ton error number -128',
  '\t\treturn ""',
  '\tend try',
  '\treturn POSIX path of chosen',
  'end run',
].join('\n');

/**
 * Same idea on Windows: a constant script, the start directory as a separate argument.
 * `-STA` is not optional – `FolderBrowserDialog` on an MTA thread silently returns nothing.
 */
const POWERSHELL_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms | Out-Null;',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
  '$d.Description = "Choose a project folder";',
  'if ($args.Count -gt 0 -and $args[0]) { $d.SelectedPath = $args[0] };',
  'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath };',
].join(' ');

const defaultRun: PickerRun = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (timedOut) {
          resolve({ timedOut: true });
          return;
        }
        clearTimeout(timer);
        // `execFile` reports a non-zero exit as an error; that is a result here, not a
        // failure. Only a spawn failure – no such binary – has no numeric `code`.
        const failure = error as (Error & { code?: number | string }) | null;
        const code = failure?.code;
        if (failure && typeof code !== 'number') {
          reject(failure);
          return;
        }
        resolve({ code: typeof code === 'number' ? code : 0, stdout });
      },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref?.();
  });

/** True when a graphical session exists at all – an SSH shell has no dialog to show. */
function hasDisplay(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

interface Command {
  tool: PickerTool;
  file: string;
  args: (startPath: string) => string[];
}

/** The dialog this host can actually show, or nothing. */
function resolveCommand(opts: PickerOptions): Command | null {
  const env = opts.env ?? process.env;
  if (env.ACR_NO_PICKER) return null;
  const platform = opts.platform ?? process.platform;

  if (platform === 'darwin') {
    const file = which('osascript', env);
    if (!file) return null;
    return {
      tool: 'osascript',
      file,
      args: (startPath) => ['-e', APPLESCRIPT, startPath],
    };
  }

  if (platform === 'win32') {
    const file = which('powershell', env) ?? which('pwsh', env);
    if (!file) return null;
    return {
      tool: 'powershell',
      file,
      args: (startPath) => ['-NoProfile', '-STA', '-Command', POWERSHELL_SCRIPT, startPath],
    };
  }

  if (!hasDisplay(env)) return null;

  const zenity = which('zenity', env);
  if (zenity) {
    return {
      tool: 'zenity',
      file: zenity,
      args: (startPath) => [
        '--file-selection',
        '--directory',
        '--title=Choose a project folder',
        ...(startPath ? [`--filename=${startPath.replace(/\/*$/, '/')}`] : []),
      ],
    };
  }

  const kdialog = which('kdialog', env);
  if (kdialog) {
    return {
      tool: 'kdialog',
      file: kdialog,
      args: (startPath) => ['--getexistingdirectory', startPath || '.'],
    };
  }

  return null;
}

export function pickerAvailability(opts: PickerOptions = {}): PickerAvailability {
  const command = resolveCommand(opts);
  return command ? { available: true, tool: command.tool } : { available: false, tool: null };
}

/** The one dialog that may be open. Cleared in a `finally`, so a failure never wedges it. */
let inFlight: Promise<PickResult> | null = null;

/**
 * Open the dialog and wait for an answer.
 *
 * Single-flight on purpose: without it a page that fires two requests stacks two modal
 * dialogs on the human's desktop, and only one of them is answering the question they
 * asked. The second caller gets a `ConflictError`, which the app maps to 409.
 */
export async function pickFolder(opts: PickerOptions = {}): Promise<PickResult> {
  if (inFlight) throw new ConflictError('a folder picker is already open');
  const attempt = runPicker(opts);
  inFlight = attempt;
  try {
    return await attempt;
  } finally {
    inFlight = null;
  }
}

async function runPicker(opts: PickerOptions): Promise<PickResult> {
  const command = resolveCommand(opts);
  if (!command) throw new PickerUnavailableError('no native folder picker on this machine');

  const run = opts.run ?? defaultRun;
  const result = await run(
    command.file,
    command.args(opts.startPath ?? ''),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  // A dialog nobody answered is the same to the caller as one they dismissed.
  if ('timedOut' in result) return { cancelled: true };

  const path = result.stdout.trim();
  if (path) return { path };
  // osascript's `-128` and zenity's `1` both mean "dismissed". Matching on the exit code
  // rather than parsing stderr keeps that from being a per-tool guessing game.
  if (result.code === 0 || result.code === 1) return { cancelled: true };
  throw new Error(`${command.tool} exited with ${result.code}`);
}

/** No dialog exists on this host. Mapped to 501 by the route – not the human's fault. */
export class PickerUnavailableError extends Error {}

export const folderPicker: FolderPicker = {
  available: (opts = {}) => pickerAvailability(opts),
  pick: (opts = {}) => pickFolder(opts),
};
