import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { doctor } from './commands/doctor.js';
import { run, UsageError } from './commands/run.js';
import { EXIT, type ExitCode } from './exit.js';
import { Renderer } from './render.js';

export const VERSION = '0.0.0';

const HELP = `acr - agent chat room

Usage:
  acr doctor [--json]
  acr run --task <text> [options]
  acr --help | --version

Commands:
  doctor        Show which agent runtimes are installed, new enough and logged in.
  run           One worker turn then one reviewer turn on a repo, streamed to the terminal.

Options for \`run\`:
  --task <text>            The task. Required unless --task-file is given.
  --task-file <path>       Read the task from a file ("-" for stdin).
  --agents <a,b>           Runtimes to use; first is the worker (default: claude,codex).
  --cwd <path>             Repo to work in (default: the current directory).
  --model-worker <model>   Model override for the worker turn.
  --model-reviewer <model> Model override for the reviewer turn.
  --timeout <seconds>      Per-read stall timeout for a turn (default: 1800).
  --allow-dirty            Run even though the working tree has uncommitted changes.
  --json                   Print a JSON summary instead of a human transcript.
  --no-color               Disable colour.

Exit codes:
  0  the reviewer approved
  1  acr or a runtime failed
  2  bad usage
  3  the reviewer did not approve (request-changes, question, or no verdict block)

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
        agents: { type: 'string', default: 'claude,codex' },
        cwd: { type: 'string' },
        title: { type: 'string' },
        'model-worker': { type: 'string' },
        'model-reviewer': { type: 'string' },
        timeout: { type: 'string', default: '1800' },
        'allow-dirty': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        color: { type: 'boolean' },
      },
      allowPositionals: false,
    }),
  );

  const task = readTask(values.task, values['task-file']);
  if (!task.trim())
    throw new UsageError('--task (or --task-file) is required and must not be empty');

  const timeoutSeconds = Number.parseFloat(values.timeout ?? '1800');
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new UsageError(`--timeout must be a positive number of seconds, got "${values.timeout}"`);
  }

  const agents = (values.agents ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  if (agents.length !== 2) {
    throw new UsageError(
      `--agents takes exactly two runtimes in M0 (worker,reviewer), got ${agents.length}`,
    );
  }

  const renderer = new Renderer(values.color === undefined ? {} : { color: values.color });
  const summary = await run({
    task,
    cwd: values.cwd ?? process.cwd(),
    agents,
    title: values.title,
    modelWorker: values['model-worker'],
    modelReviewer: values['model-reviewer'],
    timeoutMs: Math.round(timeoutSeconds * 1000),
    allowDirty: values['allow-dirty'] === true,
    renderer,
  });

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
  return summary.exitCode;
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
