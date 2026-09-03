import { execFile } from 'node:child_process';

/**
 * macOS notifications (PLAN.md section 5.7). `osascript` rather than a dependency: it is
 * already on every Mac, it needs no permission prompt for `display notification`, and the
 * cross-platform story is `node-notifier` in a later milestone.
 */
export type Spawn = (file: string, args: string[]) => void;

const defaultSpawn: Spawn = (file, args) => {
  // Fire and forget. A notification that fails must never be able to take a room down.
  execFile(file, args, { windowsHide: true }, () => undefined);
};

export interface NotifyOptions {
  platform?: NodeJS.Platform;
  spawn?: Spawn;
  /** Read from the environment when omitted, so tests can set it explicitly. */
  disabled?: boolean;
}

/**
 * Show a desktop notification, or do nothing. Returns whether it actually notified, which
 * is the only thing a test can reasonably assert without a screen.
 */
export function notify(title: string, body: string, opts: NotifyOptions = {}): boolean {
  const disabled = opts.disabled ?? Boolean(process.env.ACR_NO_NOTIFY);
  if (disabled) return false;
  if ((opts.platform ?? process.platform) !== 'darwin') return false;

  const spawn = opts.spawn ?? defaultSpawn;
  spawn('osascript', ['-e', `display notification ${quote(body)} with title ${quote(title)}`]);
  return true;
}

/**
 * AppleScript string literal. The arguments never touch a shell – `execFile` takes an argv
 * – but they do get parsed as AppleScript, so a room title with a quote in it would
 * otherwise be a syntax error at best.
 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}
