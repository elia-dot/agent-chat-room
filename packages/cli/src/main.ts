import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { doctor } from './commands/doctor.js';
import { rooms } from './commands/rooms.js';
import { run, UsageError } from './commands/run.js';
import { EXIT, type ExitCode } from './exit.js';
import { Renderer } from './render.js';

export const VERSION = '0.0.0';

const HELP = `acr - agent chat room

Usage:
  acr doctor [--json]
  acr run --task <text> [options]
  acr rooms ls | show <id> | resume <id> | close <id>
  acr --help | --version

Commands:
  doctor        Show which agent runtimes are installed, new enough and logged in.
  run           Run a room: the worker builds, the reviewers review, repeat until they agree.
  rooms         List, inspect, resume and close the rooms in the local store.

Options for \`run\`:
  --task <text>            The task. Required unless --task-file or --room is given.
  --task-file <path>       Read the task from a file ("-" for stdin).
  --agents <a,b,...>       Runtimes to use; the first is the worker, the rest review
                           (default: claude,codex, or "agents" from .acr.json).
  --cwd <path>             Repo to work in (default: the current directory).
  --rounds <n>             Give up and ask you after this many rounds (default: 4).
  --room <id>              Resume an existing room instead of opening a new one.
  --no-worktree            Work in the checkout instead of a dedicated git worktree.
  --allow-dirty            With --no-worktree: run even though the tree has changes.
  --title <text>           Room title (default: the first line of the task).
  --model-worker <model>   Model override for the worker.
  --model-reviewer <model> Model override for every reviewer.
  --timeout <seconds>      Per-read stall timeout for a turn (default: 1800, or
                           "timeoutSeconds" from .acr.json).
  --json                   Print a JSON summary instead of a human transcript.
  --no-color               Disable colour.

Every room runs on its own branch \`acr/<slug>\` in a git worktree under
~/.config/agent-chat-room/worktrees, so your checkout is never touched. The engine commits
the round that everyone approved. Per-repo defaults go in a committed \`.acr.json\`.

Exit codes:
  0  the reviewers approved
  1  acr or a runtime failed
  2  bad usage
  3  the reviewers did not approve (request-changes, question, no verdict block, or max rounds)

\`acr\` with no arguments will start the server and open the web UI. That is milestone M2;
for now it prints this help.`;

export async function main(argv: string[]): Promise<ExitCode> {
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return EXIT.ok;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.ok;
  }

  try {
    switch (command) {
      case 'doctor':
        return await doctor(parseDoctorArgs(rest));
      case 'run':
        return await runCommand(rest);
      case 'rooms':
        return await roomsCommand(rest);
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

function parseDoctorArgs(argv: string[]): { json: boolean } {
  const { values } = usageGuard(() =>
    parseArgs({
      args: argv,
      options: { json: { type: 'boolean', default: false } },
      allowPositionals: false,
    }),
  );
  return { json: values.json === true };
}

async function runCommand(argv: string[]): Promise<ExitCode> {
  const { values } = usageGuard(() =>
    parseArgs({
      args: argv,
      options: {
        task: { type: 'string' },
        'task-file': { type: 'string' },
        agents: { type: 'string' },
        cwd: { type: 'string' },
        title: { type: 'string' },
        rounds: { type: 'string' },
        room: { type: 'string' },
        resume: { type: 'string' },
        'model-worker': { type: 'string' },
        'model-reviewer': { type: 'string' },
        timeout: { type: 'string' },
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
  const rounds = values.rounds === undefined ? undefined : integer(values.rounds, '--rounds');

  const agents = splitAgents(values.agents);
  if (agents && agents.length < 2) {
    throw new UsageError(
      `--agents needs a worker and at least one reviewer, e.g. --agents claude,codex`,
    );
  }

  const renderer = new Renderer(values.color === undefined ? {} : { color: values.color });
  const summary = await run({
    ...(task.trim() ? { task } : {}),
    cwd: values.cwd ?? process.cwd(),
    ...(agents ? { agents } : {}),
    ...(roomId ? { room: roomId } : {}),
    ...(values.title ? { title: values.title } : {}),
    ...(rounds ? { maxRounds: rounds } : {}),
    ...(values['model-worker'] ? { modelWorker: values['model-worker'] } : {}),
    ...(values['model-reviewer'] ? { modelReviewer: values['model-reviewer'] } : {}),
    // `--no-worktree` arrives as `worktree: false`; leaving it unset keeps the default.
    ...(values.worktree === undefined ? {} : { worktree: values.worktree }),
    ...(timeoutSeconds ? { timeoutMs: Math.round(timeoutSeconds * 1000) } : {}),
    allowDirty: values['allow-dirty'] === true,
    renderer,
  });

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
  return summary.exitCode;
}

async function roomsCommand(argv: string[]): Promise<ExitCode> {
  const { values, positionals } = usageGuard(() =>
    parseArgs({
      args: argv,
      options: {
        cwd: { type: 'string' },
        timeout: { type: 'string', default: '1800' },
        json: { type: 'boolean', default: false },
        color: { type: 'boolean' },
      },
      allowPositionals: true,
    }),
  );

  const [subcommand = 'ls', id] = positionals;
  const timeoutSeconds = positive(values.timeout, '--timeout') ?? 1800;
  return await rooms({
    subcommand,
    ...(id ? { id } : {}),
    cwd: values.cwd ?? process.cwd(),
    json: values.json === true,
    timeoutMs: Math.round(timeoutSeconds * 1000),
    renderer: new Renderer(values.color === undefined ? {} : { color: values.color }),
  });
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
