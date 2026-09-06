import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { PERMISSION_LEVELS } from './permissions.js';
import type { Permission } from './types.js';

/**
 * `.acr.json` – optional per-repo defaults, committed alongside the code so a team shares
 * one roster (PLAN.md section 4). Precedence is CLI flags > `.acr.json` > built-ins.
 */
export const ACR_CONFIG_FILENAME = '.acr.json';

const PermissionSchema = z.enum(PERMISSION_LEVELS as unknown as [Permission, ...Permission[]]);

/** `"/path"` or `{ "path": "/path", "access": "read" }`. */
export const AdditionalDirSchema = z.union([
  z.string().min(1),
  z.object({ path: z.string().min(1), access: z.enum(['read', 'write']).optional() }),
]);

export type AdditionalDirInput = z.infer<typeof AdditionalDirSchema>;

export const RepoConfigSchema = z.object({
  /** Runtime ids. The first is the worker; the rest review. */
  agents: z.array(z.string().min(1)).optional(),
  worktree: z.boolean().optional(),
  timeoutSeconds: z.number().positive().optional(),
  /** Per-runtime model override, e.g. `{ "claude": "opus" }`. */
  models: z.record(z.string()).optional(),
  permissions: z
    .object({
      worker: PermissionSchema.optional(),
      reviewer: PermissionSchema.optional(),
    })
    .optional(),
  /**
   * Extra workspace roots to mount in agent turns. A bare string means read *and* write,
   * which is what these folders always were; the object form is how a folder is granted
   * read-only access instead.
   */
  additional_dirs: z.array(AdditionalDirSchema).optional(),
  /** Commands to execute in the worktree after creation. */
  setup: z.array(z.string()).optional(),
  /** Test command to run between worker and reviewer turns. */
  testCommand: z.string().optional(),
  /**
   * How many times a failed turn is retried before the room stops and asks a human.
   * Omitted means 0: one failure hands the room over, which is what rooms always did.
   */
  maxTurnRetries: z.number().int().min(0).max(10).optional(),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

const KNOWN_KEYS = new Set(Object.keys(RepoConfigSchema.shape));

export interface LoadedRepoConfig {
  config: RepoConfig;
  /** Absolute path of the file that was read, when there was one. */
  path?: string;
  /** Non-fatal problems: unknown keys, an unreadable file, a bad field. */
  warnings: string[];
}

/**
 * Read `<repoRoot>/.acr.json`.
 *
 * Nothing here throws. A config written by a newer `acr` must not brick an older one, so
 * unknown keys warn and are ignored, and a field that fails validation warns and falls
 * back to the built-in default. The alternative – a hard failure – means one stray key in
 * a shared repo stops everyone's rooms.
 */
export function loadRepoConfig(repoRoot: string): LoadedRepoConfig {
  const path = join(repoRoot, ACR_CONFIG_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { config: {}, warnings: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      config: {},
      path,
      warnings: [`${ACR_CONFIG_FILENAME} is not valid JSON and was ignored: ${message(err)}`],
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { config: {}, path, warnings: [`${ACR_CONFIG_FILENAME} must contain a JSON object`] };
  }

  const warnings: string[] = [];
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`${ACR_CONFIG_FILENAME}: unknown key "${key}" ignored`);
  }

  const result = RepoConfigSchema.safeParse(parsed);
  if (result.success) return { config: result.data, path, warnings };

  // Keep whatever validated. One bad field should cost that field, not the file.
  const config: RepoConfig = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KNOWN_KEYS.has(key)) continue;
    const single = RepoConfigSchema.safeParse({ [key]: value });
    if (single.success) Object.assign(config, single.data);
    else {
      warnings.push(
        `${ACR_CONFIG_FILENAME}: ignoring "${key}" – ${single.error.issues[0]?.message ?? 'invalid'}`,
      );
    }
  }
  return { config, path, warnings };
}

export interface RoomDefaults {
  agents: string[];
  worktree: boolean;
  timeoutSeconds: number;
  models: Record<string, string>;
  workerPermission: Permission;
  reviewerPermission: Permission;
  additional_dirs?: AdditionalDirInput[];
  setup?: string[];
  testCommand?: string;
  maxTurnRetries: number;
}

export const BUILTIN_DEFAULTS: RoomDefaults = {
  agents: ['claude', 'codex'],
  worktree: true,
  timeoutSeconds: 1800,
  models: {},
  workerPermission: 'edits',
  reviewerPermission: 'read-only',
  // Zero on purpose. Retrying is the room owner's decision, not a default that quietly
  // spends their tokens twice.
  maxTurnRetries: 0,
};

/** Anything the caller passed explicitly on the command line. `undefined` means "not set". */
export interface RoomOverrides {
  agents?: string[];
  worktree?: boolean;
  timeoutSeconds?: number;
  models?: Record<string, string>;
  additional_dirs?: AdditionalDirInput[];
  setup?: string[];
  testCommand?: string;
  maxTurnRetries?: number;
}

/** CLI flags > `.acr.json` > built-in defaults. */
export function resolveRoomDefaults(
  config: RepoConfig = {},
  overrides: RoomOverrides = {},
): RoomDefaults {
  return {
    agents: overrides.agents ?? config.agents ?? BUILTIN_DEFAULTS.agents,
    worktree: overrides.worktree ?? config.worktree ?? BUILTIN_DEFAULTS.worktree,
    timeoutSeconds:
      overrides.timeoutSeconds ?? config.timeoutSeconds ?? BUILTIN_DEFAULTS.timeoutSeconds,
    models: { ...BUILTIN_DEFAULTS.models, ...config.models, ...overrides.models },
    workerPermission: config.permissions?.worker ?? BUILTIN_DEFAULTS.workerPermission,
    reviewerPermission: config.permissions?.reviewer ?? BUILTIN_DEFAULTS.reviewerPermission,
    additional_dirs: overrides.additional_dirs ?? config.additional_dirs,
    setup: overrides.setup ?? config.setup,
    testCommand: overrides.testCommand ?? config.testCommand,
    maxTurnRetries:
      overrides.maxTurnRetries ?? config.maxTurnRetries ?? BUILTIN_DEFAULTS.maxTurnRetries,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
