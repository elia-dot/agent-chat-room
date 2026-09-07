import { describe, expect, it } from 'vitest';

import {
  PERMISSION_LEVELS,
  agyPermissionArgs,
  canWrite,
  claudePermissionArgs,
  codexPermissionArgs,
  cursorPermissionArgs,
  isPermission,
  opencodePermissionConfig,
} from '../src/permissions.js';

describe('the permission table', () => {
  it('gives every level a mapping for every runtime', () => {
    for (const level of PERMISSION_LEVELS) {
      expect(claudePermissionArgs(level).length).toBeGreaterThan(0);
      expect(codexPermissionArgs(level).length).toBeGreaterThan(0);
      expect(cursorPermissionArgs(level).length).toBeGreaterThan(0);
      expect(agyPermissionArgs(level).length).toBeGreaterThan(0);
      // opencode expresses permission as config rather than argv, so it is keys not flags.
      expect(Object.keys(opencodePermissionConfig(level)).length).toBeGreaterThan(0);
    }
  });

  it('disables hooks at read-only, the one path that runs outside the tool layer', () => {
    // Measured against claude 2.1.259: with `--tools Read` and no Bash at all, a loaded
    // SessionStart hook still wrote its file into the worktree during a plan-mode turn.
    // Hook commands are not tool calls, so no tool allowlist can hold them – and a
    // reviewer that writes breaks the invariant the room's write lock depends on.
    const args = claudePermissionArgs('read-only');
    expect(args).toEqual(
      expect.arrayContaining(['--settings', JSON.stringify({ disableAllHooks: true })]),
    );
    // Only read-only pays this: a worker running its own hooks is the parity being asked
    // for, and a worker is allowed to write anyway.
    expect(claudePermissionArgs('edits')).not.toContain('--settings');
    expect(claudePermissionArgs('full')).not.toContain('--settings');
  });

  it('never grants a write flag at read-only, which is what keeps reviewers honest', () => {
    expect(claudePermissionArgs('read-only')).not.toContain('acceptEdits');
    expect(claudePermissionArgs('read-only')).not.toContain('bypassPermissions');
    // `approval_policy="never"` belongs to the read-only guarantee, not to tidiness: a
    // sandboxed command that fails prompts codex to offer an unsandboxed retry, and a
    // user config that auto-approves takes the offer. Measured in `codex.ts`.
    expect(codexPermissionArgs('read-only')).toEqual([
      '-c',
      'approval_policy="never"',
      '--ignore-rules',
      '--disable',
      'hooks',
      '-s',
      'read-only',
    ]);
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
    // Probed against opencode 1.18.20. `deny` does not just refuse a call, it withholds the
    // tool: the probe answered "Model tried to call unavailable tool 'write'" and nothing
    // reached disk. This is also the level that must survive `--auto`, which the adapter
    // passes at every level so a headless turn cannot block on an approval prompt.
    expect(opencodePermissionConfig('read-only')).toEqual({
      edit: 'deny',
      bash: 'deny',
      webfetch: 'deny',
    });
    // A worker builds, tests and lints what it wrote, so `edits` grants the shell. The
    // network is the line it does not cross, which is what still separates it from `full`.
    expect(opencodePermissionConfig('edits').edit).toBe('allow');
    expect(opencodePermissionConfig('edits').bash).toBe('allow');
    expect(opencodePermissionConfig('edits').webfetch).toBe('deny');
    expect(opencodePermissionConfig('full').webfetch).toBe('allow');
    // Every level states its denials outright: with no config at all opencode allows both
    // edit and bash, so there is no safe default to fall back on.
    for (const level of PERMISSION_LEVELS) {
      expect(Object.keys(opencodePermissionConfig(level)).sort()).toEqual([
        'bash',
        'edit',
        'webfetch',
      ]);
    }
    expect(canWrite('read-only')).toBe(false);
    expect(canWrite('edits')).toBe(true);
    expect(canWrite('full')).toBe(true);
  });

  it('lets a worker run the commands that check its own work', () => {
    // The bug this pins: `--permission-mode acceptEdits` on its own auto-approves the edit
    // tools and asks about the rest, and a headless `-p` turn has nobody to ask, so the
    // approval is a refusal. Measured against claude 2.1.263 in a throwaway package:
    // `npm test` came back `permission_denied` / "This command requires approval" with
    // acceptEdits alone, and ran once `--allowedTools Bash` was added.
    expect(claudePermissionArgs('edits')).toEqual([
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Bash',
    ]);
    // The grant is Bash and nothing else: in the same probe WebFetch was still denied, so
    // `full` remains the level that stops asking about everything.
    expect(claudePermissionArgs('edits')).not.toContain('bypassPermissions');
    expect(claudePermissionArgs('edits')).not.toContain('WebFetch');
    // A reviewer is untouched by any of this – it is still plan mode, which refuses writes.
    expect(claudePermissionArgs('read-only')).toContain('plan');

    // codex and cursor already ran commands at this level; opencode had to be brought in
    // line, and Antigravity cannot be: `agy` has no mode between "no commands" and
    // "approve everything". See the note in `permissions.ts`.
    expect(codexPermissionArgs('edits')).toEqual(expect.arrayContaining(['-s', 'workspace-write']));
    expect(cursorPermissionArgs('edits')).toEqual(['--trust']);
    expect(opencodePermissionConfig('edits').bash).toBe('allow');
    expect(agyPermissionArgs('edits')).toEqual(['--mode', 'accept-edits']);
  });

  it('recognises exactly the three documented levels', () => {
    expect(isPermission('edits')).toBe(true);
    expect(isPermission('write')).toBe(false);
  });
});
