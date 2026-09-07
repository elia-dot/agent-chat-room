import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { configDir, type RoomMode } from '@agent-chat-room/core';

import { doctor } from './commands/doctor.js';
import { rooms } from './commands/rooms.js';
import { run, UsageError } from './commands/run.js';
import { serve, type ServeOptions } from './commands/serve.js';
import { EXIT, type ExitCode } from './exit.js';
import { Renderer } from './render.js';

function resolveVersion(): string {
  const candidates = [
    '../../package.json',
    '../../../package.json',
    '../../../../package.json',
    '../package.json',
  ];
  for (const rel of candidates) {
    try {
      const pkgUrl = new URL(rel, import.meta.url);
      const content = readFileSync(pkgUrl, 'utf8');
      const parsed = JSON.parse(content) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch {
      // try next
    }
  }
  return process.env.npm_package_version ?? 'unknown';
}

export const VERSION = resolveVersion();

/** Matches the ceiling in `RepoConfigSchema` and the HTTP API. */
const MAX_TURN_RETRIES = 10;

const HELP = `acr - agent chat room

Usage:
  acr                          Start the server and open the web UI.
  acr serve [--port N] [--no-open]
  acr doctor [--json] [--models]
  acr run --task <text> [options]
  acr rooms ls | show <id> | export <id> | resume <id> | merge <id> | close <id> | purge <id>
  acr data-path
  acr --help | --version

Commands:
  serve         Start the local server and open the web UI (the default with no arguments).
  doctor        Show which agent runtimes are installed, new enough and logged in.
  run           Run a room: the worker builds, the reviewers review, repeat until they agree.
  rooms         List, inspect, export, resume, merge, close and purge the rooms in the local
                store. \`merge\` merges the room branch into the branch it was cut from, in your
                own checkout, which has to be sitting clean on that branch.
  data-path     Print the directory holding database, worktrees, and logs.

Options for \`doctor\`:
  --models                 Also list the models each installed runtime offers. This is the
                           one detection path that may reach the network (cursor asks its
                           API), so it is opt-in.

Options for \`rooms\`:
  --out <path>             \`export\`: write the markdown to a file instead of stdout.

Options for \`serve\`:
  --port <n>               Port to bind (default: 4321, walking upward if it is taken).
  --no-open                Do not open a browser.

Options for \`run\`:
  --task <text>            The task. Required unless --task-file or --room is given.
  --task-file <path>       Read the task from a file ("-" for stdin).
  --agents <a,b,...>       Runtimes to use; the first is the worker, the rest review
                           (default: claude,codex, or "agents" from .acr.json).
  --cwd <path>             Repo to work in (default: the current directory).
  --mode <mode>            build-review (default) or brainstorm. A brainstorm is three
                           phases – everyone answers, everyone reacts, the last agent
                           writes the merged proposal – and nobody edits files.
  --room <id>              Resume an existing room instead of opening a new one.
  --no-worktree            Work in the checkout instead of a dedicated git worktree.
                           The room still branches, cut from the fetched base, so you need
                           not be standing on the trunk to start one.
  --allow-dirty            With --no-worktree: run even though the tree has changes.
  --title <text>           Room title (default: the first line of the task).
  --model-worker <model>   Model override for the worker.
  --model-reviewer <model> Model override for every reviewer.
  --model <rt>=<model>     Model override for one runtime, repeatable
                           (e.g. --model claude=opus --model codex=gpt-5.3-codex).
  --timeout <seconds>      Per-read stall timeout for a turn (default: 1800, or
                           "timeoutSeconds" from .acr.json).
  --retries <n>            Retry a failed turn up to n times before handing the room
                           back to you (default: 0, or "maxTurnRetries" from
                           .acr.json). A turn you stop yourself is never retried.
  --json                   Print a JSON summary instead of a human transcript.
  --no-color               Disable colour.

Every room runs on its own branch \`acr/<slug>\`. By default that branch is checked out in a
git worktree under ~/.config/agent-chat-room/worktrees, so your own checkout is never
touched; \`--no-worktree\` works in the checkout instead, and moves it to the room branch.
The engine commits the round that everyone approved. Per-repo defaults go in a committed
\`.acr.json\`.

Exit codes:
  0  the reviewers approved
  1  acr or a runtime failed
  2  bad usage
  3  the reviewers did not approve (a question for you, or the run was stopped)

The server binds 127.0.0.1 only. Agent CLIs contact their providers; Git may contact remotes. Rooms
run inside the \`acr serve\` process: closing the browser tab does not stop them, Ctrl-C does.`;

/** Injectable seams, so `main.test.ts` can exercise the argument handling hermetically. */
export interface MainOptions {
  serve?: (opts: ServeOptions) => Promise<ExitCode>;
}

export async function main(argv: string[], opts: MainOptions = {}): Promise<ExitCode> {
  const [command, ...rest] = argv;

  // Bare `acr` starts the UI. `--help` is the stable spelling for the help text; it used
  // to be what no arguments did, and a script relying on that gets a server instead.
  if (command === undefined) {
    return await serveCommand([], opts);
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return EXIT.ok;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.ok;
  }

  try {
    switch (command) {
      case 'serve':
        return await serveCommand(rest, opts);
      case 'doctor':
        return await doctor(parseDoctorArgs(rest));
      case 'run':
        return await runCommand(rest);
      case 'rooms':
        return await roomsCommand(rest);
      case 'data-path':
        process.stdout.write(`${configDir()}\n`);
        return EXIT.ok;
      default:
        process.stderr.write(`acr: unknown command "${command}"\n\n${HELP}\n`);
        return EXIT.usage;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`acr: ${err.message}\n`);
      return EXIT.usage;
    }
    process.stderr.write(
      `acr: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    return EXIT.internalError;
  }
}

/**
 * `node:util`'s `parseArgs` has no `--no-flag` negation – it answers "Unknown option
 * '--no-open'" – so the documented negative flags are pulled out of argv here and folded
 * back in as `false`. Anything after a bare `--` is left alone.
 */
function withNegations(
  argv: string[],
  names: readonly string[],
): { argv: string[]; negated: Record<string, false> } {
  const negated: Record<string, false> = {};
  const rest: string[] = [];
  let passthrough = false;
  for (const arg of argv) {
    if (passthrough) {
      rest.push(arg);
      continue;
    }
    if (arg === '--') {
      passthrough = true;
      rest.push(arg);
      continue;
    }
    const name = /^--no-(.+)$/.exec(arg)?.[1];
    if (name && names.includes(name)) {
      negated[name] = false;
      continue;
    }
    rest.push(arg);
  }
  return { argv: rest, negated };
}

/**
 * `parseArgs` throws a plain TypeError on an unknown flag. That is bad usage, not an
 * internal failure, so it has to come back as exit code 2 with a readable message.
 */
function usageGuard<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (code.startsWith('ERR_PARSE_ARGS')) {
      throw new UsageError(err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

async function serveCommand(argv: string[], opts: MainOptions): Promise<ExitCode> {
  const flags = withNegations(argv, ['open', 'color']);
  const { values } = usageGuard(() =>
    parseArgs({
      args: flags.argv,
      options: {
        port: { type: 'string' },
        open: { type: 'boolean' },
        color: { type: 'boolean' },
      },
      allowPositionals: false,
    }),
  );

  const port = values.port === undefined ? undefined : integer(values.port, '--port');
  if (port !== undefined && port > 65_535) {
    throw new UsageError(`--port must be a valid port number, got "${values.port}"`);
  }
  const open = values.open ?? flags.negated.open;
  const color = values.color ?? flags.negated.color;

  return await (opts.serve ?? serve)({
    ...(port === undefined ? {} : { port }),
    ...(open === undefined ? {} : { open }),
    renderer: new Renderer(color === undefined ? {} : { color }),
  });
}

function parseDoctorArgs(argv: string[]): { json: boolean; models: boolean } {
  const { values } = usageGuard(() =>
    parseArgs({
      args: argv,
      options: {
        json: { type: 'boolean', default: false },
        models: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    }),
  );
  return { json: values.json === true, models: values.models === true };
}

async function runCommand(argv: string[]): Promise<ExitCode> {
  const flags = withNegations(argv, ['worktree', 'color']);
  const { values } = usageGuard(() =>
    parseArgs({
      args: flags.argv,
      options: {
        task: { type: 'string' },
        'task-file': { type: 'string' },
        agents: { type: 'string' },
        cwd: { type: 'string' },
        title: { type: 'string' },
        mode: { type: 'string' },
        model: { type: 'string', multiple: true },
        room: { type: 'string' },
        resume: { type: 'string' },
        'model-worker': { type: 'string' },
        'model-reviewer': { type: 'string' },
        timeout: { type: 'string' },
        retries: { type: 'string' },
        worktree: { type: 'boolean' },
        'allow-dirty': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        color: { type: 'boolean' },
      },
      allowPositionals: false,
    }),
  );

  const roomId = values.room ?? values.resume;
  const task = readTask(values.task, values['task-file']);
  if (!roomId && !task.trim()) {
    throw new UsageError('--task (or --task-file, or --room to resume) is required');
  }

  const timeoutSeconds = positive(values.timeout, '--timeout');
  const retries = nonNegative(values.retries, '--retries');

  const agents = splitAgents(values.agents);
  if (agents && agents.length < 2) {
    throw new UsageError(
      `--agents needs a worker and at least one reviewer, e.g. --agents claude,codex`,
    );
  }

  const mode = parseMode(values.mode);
  const models = parseModels(values.model);
  const worktree = values.worktree ?? flags.negated.worktree;
  const color = values.color ?? flags.negated.color;
  const renderer = new Renderer(color === undefined ? {} : { color });
  const summary = await run({
    ...(task.trim() ? { task } : {}),
    cwd: values.cwd ?? process.cwd(),
    ...(agents ? { agents } : {}),
    ...(mode ? { mode } : {}),
    ...(models ? { models } : {}),
    ...(roomId ? { room: roomId } : {}),
    ...(values.title ? { title: values.title } : {}),
    ...(values['model-worker'] ? { modelWorker: values['model-worker'] } : {}),
    ...(values['model-reviewer'] ? { modelReviewer: values['model-reviewer'] } : {}),
    // `--no-worktree` arrives as `worktree: false`; leaving it unset keeps the default.
    ...(worktree === undefined ? {} : { worktree }),
    ...(timeoutSeconds ? { timeoutMs: Math.round(timeoutSeconds * 1000) } : {}),
    ...(retries === undefined ? {} : { maxTurnRetries: retries }),
    allowDirty: values['allow-dirty'] === true,
    renderer,
  });

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
  return summary.exitCode;
}

async function roomsCommand(argv: string[]): Promise<ExitCode> {
  const flags = withNegations(argv, ['color']);
  const { values, positionals } = usageGuard(() =>
    parseArgs({
      args: flags.argv,
      options: {
        cwd: { type: 'string' },
        out: { type: 'string' },
        timeout: { type: 'string', default: '1800' },
        json: { type: 'boolean', default: false },
        color: { type: 'boolean' },
      },
      allowPositionals: true,
    }),
  );

  const [subcommand = 'ls', id] = positionals;
  const color = values.color ?? flags.negated.color;
  const timeoutSeconds = positive(values.timeout, '--timeout') ?? 1800;
  return await rooms({
    subcommand,
    ...(id ? { id } : {}),
    ...(values.out ? { out: values.out } : {}),
    cwd: values.cwd ?? process.cwd(),
    json: values.json === true,
    timeoutMs: Math.round(timeoutSeconds * 1000),
    renderer: new Renderer(color === undefined ? {} : { color }),
  });
}

function parseMode(value: string | undefined): RoomMode | undefined {
  if (value === undefined) return undefined;
  if (value !== 'build-review' && value !== 'brainstorm') {
    throw new UsageError(`--mode must be build-review or brainstorm, got "${value}"`);
  }
  return value;
}

/** `--model claude=opus --model codex=gpt-5.3-codex` -> `{ claude: 'opus', codex: '...' }`. */
function parseModels(values: string[] | undefined): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  const models: Record<string, string> = {};
  for (const value of values) {
    const eq = value.indexOf('=');
    const runtime = eq === -1 ? '' : value.slice(0, eq).trim();
    const model = eq === -1 ? '' : value.slice(eq + 1).trim();
    if (!runtime || !model) {
      throw new UsageError(`--model takes <runtime>=<model>, got "${value}"`);
    }
    models[runtime] = model;
  }
  return models;
}

function splitAgents(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const agents = value
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  return agents.length > 0 ? agents : undefined;
}

function positive(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} must be a positive number, got "${value}"`);
  }
  return parsed;
}

/**
 * Like `positive`, but 0 is a legal answer – it is how you say "never retry".
 *
 * `Number` rather than `parseInt`, deliberately: `parseInt('1.5', 10)` is 1, so a parsed
 * count would silently round a typo into a number the user did not ask for.
 */
function nonNegative(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`${flag} must be a whole number of 0 or more, got "${value}"`);
  }
  // The same ceiling `.acr.json` and the HTTP API enforce, so no entry point can set a
  // budget the others would refuse to display.
  if (parsed > MAX_TURN_RETRIES) {
    throw new UsageError(`${flag} can be at most ${MAX_TURN_RETRIES}, got "${value}"`);
  }
  return parsed;
}

function integer(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function readTask(task: string | undefined, taskFile: string | undefined): string {
  if (task !== undefined && taskFile !== undefined) {
    throw new UsageError('pass either --task or --task-file, not both');
  }
  if (taskFile !== undefined) {
    return readFileSync(taskFile === '-' ? 0 : taskFile, 'utf8');
  }
  return task ?? '';
}
