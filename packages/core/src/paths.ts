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

/** Capability token for server authentication. Mode 0600. */
export function serverTokenPath(): string {
  return join(configDir(), 'server.token');
}

/** The single SQLite file that holds every room. Migrated forward only. */
export function dbPath(): string {
  return join(configDir(), 'acr.db');
}

/**
 * Room worktrees. Deliberately outside any repo: a worktree nested inside its own
 * checkout shows up in `git status` and in every glob the agents run.
 */
export function worktreesDir(): string {
  return join(configDir(), 'worktrees');
}

export function roomWorktreePath(roomId: string): string {
  return join(worktreesDir(), roomId);
}

/** Advisory cross-process write locks, one file per repo. See `engine/lock.ts`. */
export function locksDir(): string {
  return join(configDir(), 'locks');
}

/**
 * The per-room lock (see `engine/lock.ts`). Separate from the per-repo write lock: that one
 * protects a working tree from two writers, this one protects a room *row* from two engines
 * interleaving state writes – which is what the README used to warn about.
 */
export function roomLockPath(roomId: string): string {
  return join(locksDir(), `room-${roomId}.lock`);
}

/** Overflow storage for diffs too large to keep in a SQLite row. */
export function diffsDir(): string {
  return join(configDir(), 'diffs');
}

export function diffPath(messageId: string): string {
  return join(diffsDir(), `${messageId}.diff`);
}

/**
 * Files the human dropped into a chat: images, documents, and the transcripts of rooms
 * they referenced. One folder per room, because that folder is handed to the runtimes as
 * an extra read root and a room has no business reading another room's uploads.
 */
export function attachmentsDir(): string {
  return join(configDir(), 'attachments');
}

export function roomAttachmentsDir(roomId: string): string {
  return join(attachmentsDir(), roomId);
}

/**
 * Where one attachment lives. The name on disk is derived from the server-minted id plus
 * the original extension, never from the caller's filename, so nothing a browser sends can
 * steer the write out of the room's folder.
 */
export function attachmentPath(roomId: string, attachmentId: string, extension = ''): string {
  return join(roomAttachmentsDir(roomId), `${attachmentId}${extension}`);
}
