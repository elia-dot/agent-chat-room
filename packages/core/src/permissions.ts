import type { Permission } from './types.js';

/**
 * The permission table from PLAN.md section 4.1.
 *
 * Keeping every vendor flag in this one file is deliberate: the engine only ever talks
 * about `read-only | edits | full`, so adding a runtime never means teaching the room
 * engine a new flag, and auditing "can this turn write to my repo?" means reading one
 * table instead of grepping three adapters.
 */
export const PERMISSION_LEVELS: readonly Permission[] = ['read-only', 'edits', 'full'] as const;

export function isPermission(value: string): value is Permission {
  return (PERMISSION_LEVELS as readonly string[]).includes(value);
}

export function claudePermissionArgs(permission: Permission): string[] {
  switch (permission) {
    case 'read-only':
      // `--permission-mode plan` already refuses edits; `--tools` narrows the surface
      // further so a plan-mode turn cannot shell out either.
      return ['--permission-mode', 'plan', '--tools', 'Read,Glob,Grep'];
    case 'edits':
      return ['--permission-mode', 'acceptEdits'];
    case 'full':
      return ['--permission-mode', 'bypassPermissions'];
  }
}

export function codexPermissionArgs(permission: Permission): string[] {
  switch (permission) {
    case 'read-only':
      return ['-s', 'read-only'];
    case 'edits':
      return ['-s', 'workspace-write'];
    case 'full':
      return ['--dangerously-bypass-approvals-and-sandbox'];
  }
}

/** True when a permission level lets the runtime modify the working tree. */
export function canWrite(permission: Permission): boolean {
  return permission !== 'read-only';
}
