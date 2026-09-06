import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_DEFAULTS, loadRepoConfig, resolveRoomDefaults } from '../src/config.js';
import { makeRepo } from './helpers.js';

const repos: string[] = [];

function repoWith(config?: unknown): string {
  const dir = makeRepo({ 'math.js': 'x\n' });
  repos.push(dir);
  if (config !== undefined) {
    writeFileSync(
      join(dir, '.acr.json'),
      typeof config === 'string' ? config : JSON.stringify(config, null, 2),
    );
  }
  return dir;
}

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('.acr.json', () => {
  it('is optional', () => {
    const loaded = loadRepoConfig(repoWith());
    expect(loaded.config).toEqual({});
    expect(loaded.warnings).toEqual([]);
    expect(resolveRoomDefaults(loaded.config)).toEqual(BUILTIN_DEFAULTS);
  });

  it('overrides the built-in defaults', () => {
    const dir = repoWith({
      agents: ['codex', 'claude', 'cursor'],
      worktree: false,
      timeoutSeconds: 60,
      models: { claude: 'opus' },
      permissions: { worker: 'full' },
    });
    const loaded = loadRepoConfig(dir);
    expect(loaded.warnings).toEqual([]);

    const settings = resolveRoomDefaults(loaded.config);
    expect(settings.agents).toEqual(['codex', 'claude', 'cursor']);
    expect(settings.worktree).toBe(false);
    expect(settings.timeoutSeconds).toBe(60);
    expect(settings.models).toEqual({ claude: 'opus' });
    expect(settings.workerPermission).toBe('full');
    expect(settings.reviewerPermission).toBe('read-only');
  });

  it('lets a CLI flag win over the file, and the file over the defaults', () => {
    const loaded = loadRepoConfig(repoWith({ agents: ['codex', 'claude'], timeoutSeconds: 60 }));
    const settings = resolveRoomDefaults(loaded.config, { timeoutSeconds: 20 });
    expect(settings.timeoutSeconds).toBe(20);
    expect(settings.agents).toEqual(['codex', 'claude']);
    expect(settings.worktree).toBe(BUILTIN_DEFAULTS.worktree);
  });

  it('merges model maps rather than replacing them wholesale', () => {
    const loaded = loadRepoConfig(repoWith({ models: { claude: 'opus', codex: 'gpt' } }));
    const settings = resolveRoomDefaults(loaded.config, { models: { codex: 'override' } });
    expect(settings.models).toEqual({ claude: 'opus', codex: 'override' });
  });

  it('warns about an unknown key instead of failing', () => {
    // A config written by a newer acr must not brick an older one.
    const loaded = loadRepoConfig(repoWith({ worktree: false, futureFeature: { on: true } }));
    expect(loaded.config.worktree).toBe(false);
    expect(loaded.warnings.join('\n')).toMatch(/unknown key "futureFeature"/);
  });

  it('drops one bad field and keeps the rest', () => {
    const loaded = loadRepoConfig(repoWith({ timeoutSeconds: -1, agents: ['echo', 'echo'] }));
    expect(loaded.config.agents).toEqual(['echo', 'echo']);
    expect(loaded.config.timeoutSeconds).toBeUndefined();
    expect(loaded.warnings.join('\n')).toMatch(/ignoring "timeoutSeconds"/);
  });

  it('ignores a file that is not valid JSON', () => {
    const loaded = loadRepoConfig(repoWith('{ this is not json'));
    expect(loaded.config).toEqual({});
    expect(loaded.warnings.join('\n')).toMatch(/not valid JSON/);
  });

  it('rejects a permission the engine does not understand', () => {
    const loaded = loadRepoConfig(repoWith({ permissions: { worker: 'sudo' } }));
    expect(loaded.config.permissions).toBeUndefined();
    expect(loaded.warnings.length).toBeGreaterThan(0);
  });

  it('accepts additional_dirs, setup, and testCommand', () => {
    const loaded = loadRepoConfig(
      repoWith({
        additional_dirs: ['/extra/path'],
        setup: ['npm ci'],
        testCommand: 'npm test',
      }),
    );
    expect(loaded.warnings).toEqual([]);
    expect(loaded.config.additional_dirs).toEqual(['/extra/path']);
    expect(loaded.config.setup).toEqual(['npm ci']);
    expect(loaded.config.testCommand).toBe('npm test');

    const settings = resolveRoomDefaults(loaded.config);
    expect(settings.additional_dirs).toEqual(['/extra/path']);
    expect(settings.setup).toEqual(['npm ci']);
    expect(settings.testCommand).toBe('npm test');
  });
  it('takes maxTurnRetries from .acr.json, and lets a flag beat it', () => {
    // The room owner decides whether a failure is retried; the built-in answer is "no", so
    // an existing repo behaves exactly as it did before the setting existed.
    expect(resolveRoomDefaults({}).maxTurnRetries).toBe(0);

    const loaded = loadRepoConfig(repoWith({ maxTurnRetries: 2 }));
    expect(loaded.warnings).toEqual([]);
    expect(resolveRoomDefaults(loaded.config).maxTurnRetries).toBe(2);

    // CLI flags > .acr.json > built-in, including the flag that turns retrying back off.
    expect(resolveRoomDefaults(loaded.config, { maxTurnRetries: 3 }).maxTurnRetries).toBe(3);
    expect(resolveRoomDefaults(loaded.config, { maxTurnRetries: 0 }).maxTurnRetries).toBe(0);
  });

  it('ignores a nonsensical maxTurnRetries rather than opening with it', () => {
    const loaded = loadRepoConfig(repoWith({ maxTurnRetries: -1 }));
    expect(loaded.warnings.join(' ')).toMatch(/maxTurnRetries/);
    expect(resolveRoomDefaults(loaded.config).maxTurnRetries).toBe(0);
  });
});
