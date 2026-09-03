import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * State lives in `~/.config/agent-chat-room/` (PLAN.md section 4). `XDG_CONFIG_HOME` is
 * honoured because plenty of Linux users move it, and `ACR_CONFIG_DIR` exists so tests
 * (and anyone with two checkouts) can point somewhere disposable.
 */
export function configDir(): string {
  const override = process.env.ACR_CONFIG_DIR;
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, 'agent-chat-room');
  return join(homedir(), '.config', 'agent-chat-room');
}

export function turnsDir(): string {
  return join(configDir(), 'turns');
}

export function turnLogPath(turnId: string): string {
  return join(turnsDir(), `${turnId}.jsonl`);
}
