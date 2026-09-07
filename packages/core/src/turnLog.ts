import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { turnLogPath } from './paths.js';

/**
 * Appends every raw line a runtime emitted to `~/.config/agent-chat-room/turns/<turnId>.jsonl`
 * This is the first thing you read when an adapter misbehaves, so it
 * records the bytes as they arrived rather than the parsed events.
 *
 * Logging is strictly best effort: a full disk or a read-only home must never take a turn down.
 */
export class TurnLog {
  private readonly path: string | undefined;
  private failed = false;

  constructor(turnId: string, enabled = process.env.ACR_NO_TURN_LOG !== '1') {
    this.path = enabled ? turnLogPath(turnId) : undefined;
  }

  append(line: string): void {
    if (!this.path || this.failed) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, line.endsWith('\n') ? line : `${line}\n`);
    } catch {
      // One warning, then stay quiet for the rest of the turn.
      this.failed = true;
    }
  }

  get filePath(): string | undefined {
    return this.path;
  }
}
