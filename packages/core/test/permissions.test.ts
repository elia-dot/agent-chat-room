import { describe, expect, it } from 'vitest';

import {
  PERMISSION_LEVELS,
  canWrite,
  claudePermissionArgs,
  codexPermissionArgs,
  isPermission,
} from '../src/permissions.js';

describe('the permission table', () => {
  it('gives every level a mapping for every runtime', () => {
    for (const level of PERMISSION_LEVELS) {
      expect(claudePermissionArgs(level).length).toBeGreaterThan(0);
      expect(codexPermissionArgs(level).length).toBeGreaterThan(0);
    }
  });

  it('never grants a write flag at read-only, which is what keeps reviewers honest', () => {
    expect(claudePermissionArgs('read-only')).not.toContain('acceptEdits');
    expect(claudePermissionArgs('read-only')).not.toContain('bypassPermissions');
    expect(codexPermissionArgs('read-only')).toEqual(['-s', 'read-only']);
    expect(canWrite('read-only')).toBe(false);
    expect(canWrite('edits')).toBe(true);
    expect(canWrite('full')).toBe(true);
  });

  it('recognises exactly the three documented levels', () => {
    expect(isPermission('edits')).toBe(true);
    expect(isPermission('write')).toBe(false);
  });
});
