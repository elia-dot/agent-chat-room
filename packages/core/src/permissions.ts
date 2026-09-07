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
      // `--permission-mode plan` is what refuses edits; `--tools` picks the surface a
      // reviewer needs to do its job. `Skill` is on the list because a reviewer that
      // cannot load a skill cannot follow the house review rules that live in one, and
      // `Bash` because most skills shell out to their own scripts and are inert without
      // it – a skill only reads instructions into context, so the tools it then reaches
      // for are checked against this same list.
      //
      // Adding `Bash` does not hand a reviewer a writable shell. Probed against claude
      // 2.1.259: a plan-mode turn runs `cat`/`git log` but refuses `echo > file`, and it
      // still refuses with `permissions.allow: ["Bash","Bash(echo:*)","Write"]` and
      // `defaultMode: bypassPermissions` in a loaded settings file – no Bash tool call is
      // even attempted. Allow rules raise a ceiling; they do not lift plan mode.
      //
      // `disableAllHooks` is the exception that had to be handled, and it is not
      // cosmetic. Hook commands run outside the tool-permission layer entirely, so a
      // loaded `SessionStart` hook writes to the worktree during a read-only turn: with
      // `--tools Read` alone and no Bash at all, a hook still created its file. That
      // breaks the invariant the room's write lock rests on – reviewers do not write.
      // Suppressing hooks costs nothing else; all 17 skills still load with it set.
      return [
        '--permission-mode',
        'plan',
        '--tools',
        'Read,Glob,Grep,Skill,Bash',
        '--settings',
        JSON.stringify({ disableAllHooks: true }),
      ];
    case 'edits':
      // `acceptEdits` alone auto-approves the edit tools and a narrow set of shell calls,
      // and asks for everything else – which in a headless `-p` turn is a refusal, because
      // nobody is there to answer. Probed against claude 2.1.263 in a throwaway package:
      // `npm test` came back `permission_denied`, "This command requires approval", so a
      // worker could write a change and then not build, test or lint it.
      //
      // `--allowedTools Bash` is what lifts that, and only that: the same probe with it
      // set ran `npm test`, while WebFetch was still denied ("you haven't granted it
      // yet"). So `edits` is a worker that may work in the repo, and `full` is still the
      // level that stops asking about anything at all.
      return ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash'];
    case 'full':
      return ['--permission-mode', 'bypassPermissions'];
  }
}

/**
 * The three things a sandboxed codex turn pins regardless of what the developer's own
 * configuration says. Each closes a different route around the sandbox, and none of them
 * costs a room a skill, an MCP server or an instruction. All three are measured; see
 * `CODEX_NEVER_ESCALATE` in `codex.ts` for the probes behind each.
 */
const CODEX_SANDBOX_PINS = [
  '-c',
  'approval_policy="never"',
  '--ignore-rules',
  '--disable',
  'hooks',
] as const;

export function codexPermissionArgs(permission: Permission): string[] {
  switch (permission) {
    case 'read-only':
      return [...CODEX_SANDBOX_PINS, '-s', 'read-only'];
    case 'edits':
      return [...CODEX_SANDBOX_PINS, '-s', 'workspace-write'];
    case 'full':
      return ['--dangerously-bypass-approvals-and-sandbox'];
  }
}

/**
 * Cursor Agent. Probed against cursor-agent 2026.07.23: `--mode ask` genuinely refuses to
 * write – a turn asked to create a file answers "Ask mode is active … writing would be an
 * edit" and no file appears – and it blocks shell commands outright, which is stronger than
 * the sandbox flag alone. `--trust` is on every level because a headless turn has nobody to
 * answer the "do you trust this workspace?" prompt.
 *
 * Under `userConfig` this row rests on `--sandbox enabled`, whose own help text is
 * "explicitly enable or disable sandbox mode (overrides config)" – an argv flag that beats
 * the config file is exactly what keeps a developer's settings from widening a reviewer.
 * Unlike claude, codex and agy, that has NOT been re-probed live since the default changed:
 * the account hit `ActionRequiredError: You've hit your usage limit` before a turn could
 * run. Documented behaviour and the 2026.07.23 probe above, not a fresh measurement.
 */
export function cursorPermissionArgs(permission: Permission): string[] {
  switch (permission) {
    case 'read-only':
      return ['--mode', 'ask', '--sandbox', 'enabled', '--trust'];
    case 'edits':
      return ['--trust'];
    case 'full':
      return ['--force', '--trust'];
  }
}

/**
 * Antigravity (`agy`). Each row probed against agy 1.1.26 by asking one turn to write a
 * file *and* run a shell command in a throwaway directory:
 *
 *  - `--sandbox` refuses `write_to_file` and refuses `echo X > file` at the command
 *    permission layer, while still allowing a plain read-only `ls`. Nothing reached disk.
 *  - `--mode accept-edits` wrote the file and auto-denied `run_command` with "user denied
 *    permission to run command". This is the one runtime whose `edits` cannot mean what it
 *    means everywhere else – `agy --help` offers only `accept-edits`, `plan`, `--sandbox`
 *    and `--dangerously-skip-permissions`, so there is no mode between "may not run a
 *    command" and "approves everything". An agy worker that has to build or test its own
 *    work needs `full`; the README table says so rather than pretending otherwise.
 *  - `--dangerously-skip-permissions` reports `permission_mode: always-proceed`, and both
 *    the write and the shell ran.
 *
 * `--mode plan` also blocks writes and is deliberately *not* used for `read-only`: it
 * expands a system `plan` slash command that changes the agent's persona, and a probe under
 * it answered "I have created the implementation plan… please review it" instead of doing
 * the task – which would derail a reviewer that has to emit a fenced verdict block.
 *
 * Re-probed once `userConfig` made loading a developer's own settings the default, because
 * agy's denial names `permissions.allow in settings.json` as the way to lift it – the same
 * shape of hole that let a user config defeat codex's sandbox. It does not apply here:
 * against `--sandbox`, `command(*)`, `command` and an exact-command rule were each still
 * denied and nothing reached disk. `--sandbox` outranks the allow list.
 */
export function agyPermissionArgs(permission: Permission): string[] {
  switch (permission) {
    case 'read-only':
      return ['--sandbox'];
    case 'edits':
      return ['--mode', 'accept-edits'];
    case 'full':
      return ['--dangerously-skip-permissions'];
  }
}

/**
 * opencode. The odd one out: `opencode run` has no permission flags at all, so this table
 * returns the `permission` block of a config document rather than argv. The adapter hands
 * it over in `OPENCODE_CONFIG_CONTENT`, which is why it is a plain object here.
 *
 * Each row probed against opencode 1.18.20 by asking one turn to write a file *and* run a
 * shell command in a throwaway directory:
 *
 *  - `deny` does not merely refuse a call, it removes the tool from the model's toolset:
 *    the probe answered "Model tried to call unavailable tool 'write'. Available tools:
 *    glob, grep, invalid, read, ..." and nothing reached disk.
 *  - the default with no config at all is `allow` for *both* edit and bash, so a turn that
 *    forgets this table is a `full` turn. Every level therefore states its denials
 *    explicitly rather than relying on a safe default, because there isn't one.
 *  - `edits` allows bash and still denies webfetch: a worker is expected to build, test and
 *    lint the change it just wrote, which is shell work, and none of it needs the network.
 *
 * Two precedence facts this relies on, both probed rather than assumed:
 *  - `--auto` does *not* override a `deny`. With `edit: deny` and `--auto` together the
 *    write tool was still absent. The adapter passes `--auto` at every level so a turn can
 *    never block on an approval prompt nobody is there to answer, and these denials still
 *    hold the line.
 *  - `OPENCODE_CONFIG_CONTENT` beats the target repo's own `opencode.json`. A repo that
 *    sets `permission.edit: "allow"` cannot talk a `read-only` reviewer into writing.
 */
export function opencodePermissionConfig(permission: Permission): Record<string, string> {
  switch (permission) {
    case 'read-only':
      return { edit: 'deny', bash: 'deny', webfetch: 'deny' };
    case 'edits':
      return { edit: 'allow', bash: 'allow', webfetch: 'deny' };
    case 'full':
      return { edit: 'allow', bash: 'allow', webfetch: 'allow' };
  }
}

/** True when a permission level lets the runtime modify the working tree. */
export function canWrite(permission: Permission): boolean {
  return permission !== 'read-only';
}
