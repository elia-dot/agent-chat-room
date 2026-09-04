import { describe, expect, it } from 'vitest';

import {
  PERMISSION_LEVELS,
  agyPermissionArgs,
  canWrite,
  claudePermissionArgs,
  codexPermissionArgs,
  cursorPermissionArgs,
  isPermission,
} from '../src/permissions.js';

describe('the permission table', () => {
  it('gives every level a mapping for every runtime', () => {
    for (const level of PERMISSION_LEVELS) {
      expect(claudePermissionArgs(level).length).toBeGreaterThan(0);
      expect(codexPermissionArgs(level).length).toBeGreaterThan(0);
      expect(cursorPermissionArgs(level).length).toBeGreaterThan(0);
      expect(agyPermissionArgs(level).length).toBeGreaterThan(0);
    }
  });

  it('never grants a write flag at read-only, which is what keeps reviewers honest', () => {
    expect(claudePermissionArgs('read-only')).not.toContain('acceptEdits');
    expect(claudePermissionArgs('read-only')).not.toContain('bypassPermissions');
    expect(codexPermissionArgs('read-only')).toEqual(['-s', 'read-only']);
    // PLAN.md section 4.1, confirmed by a live probe against cursor-agent 2026.07.23: a
    // turn in `ask` mode refuses to create a file and its shell calls come back denied.
    expect(cursorPermissionArgs('read-only')).toEqual([
      '--mode',
      'ask',
      '--sandbox',
      'enabled',
      '--trust',
    ]);
    expect(cursorPermissionArgs('read-only')).not.toContain('--force');
    expect(cursorPermissionArgs('edits')).not.toContain('--force');
    expect(cursorPermissionArgs('full')).toContain('--force');
    // Probed against agy 1.1.26: under `--sandbox` a write and a redirecting shell command
    // were both refused and nothing reached disk.
    expect(agyPermissionArgs('read-only')).toEqual(['--sandbox']);
    expect(agyPermissionArgs('read-only')).not.toContain('--dangerously-skip-permissions');
    expect(agyPermissionArgs('edits')).not.toContain('--dangerously-skip-permissions');
    expect(agyPermissionArgs('full')).toContain('--dangerously-skip-permissions');
    expect(canWrite('read-only')).toBe(false);
    expect(canWrite('edits')).toBe(true);
    expect(canWrite('full')).toBe(true);
  });

  it('recognises exactly the three documented levels', () => {
    expect(isPermission('edits')).toBe(true);
    expect(isPermission('write')).toBe(false);
  });
});
