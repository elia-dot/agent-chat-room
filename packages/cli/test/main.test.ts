import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXIT } from '../src/exit.js';
import type { ServeOptions } from '../src/commands/serve.js';
import { main } from '../src/main.js';

let out: string[];
let err: string[];
let served: ServeOptions[];

/** A stand-in for `serve`, so the argument tests never open a port. */
const fakeServe = (opts: ServeOptions): Promise<typeof EXIT.ok> => {
  served.push(opts);
  return Promise.resolve(EXIT.ok);
};

beforeEach(() => {
  out = [];
  err = [];
  served = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('acr argument handling', () => {
  it('starts the server with no arguments, rather than printing help', async () => {
    // The M2 behaviour change: bare `acr` used to print help. `--help` is the stable
    // spelling, and any script relying on the old default now gets a server.
    expect(await main([], { serve: fakeServe })).toBe(EXIT.ok);
    expect(served).toHaveLength(1);
    expect(served[0]?.port).toBeUndefined();
    expect(out.join('')).not.toContain('Usage:');
  });

  it('passes --port and --no-open through to serve', async () => {
    expect(await main(['serve', '--port', '5000', '--no-open'], { serve: fakeServe })).toBe(
      EXIT.ok,
    );
    expect(served[0]).toMatchObject({ port: 5000, open: false });

    expect(await main(['serve'], { serve: fakeServe })).toBe(EXIT.ok);
    expect(served[1]?.open).toBeUndefined();
  });

  it('rejects a bad serve flag with the usage code', async () => {
    expect(await main(['serve', '--bogus'], { serve: fakeServe })).toBe(EXIT.usage);
    expect(await main(['serve', '--port', 'soon'], { serve: fakeServe })).toBe(EXIT.usage);
    expect(await main(['serve', '--port', '99999'], { serve: fakeServe })).toBe(EXIT.usage);
    expect(served).toEqual([]);
  });

  it('still prints help for --help', async () => {
    expect(await main(['--help'], { serve: fakeServe })).toBe(EXIT.ok);
    expect(out.join('')).toContain('acr doctor');
    expect(served).toEqual([]);
  });

  it('documents --retries in --help', async () => {
    await main(['--help']);
    expect(out.join('')).toContain('--retries <n>');
  });

  it('rejects a --retries that is not a whole number of 0 or more', async () => {
    // Validated while the arguments are parsed, before anything opens a repo or a room, so
    // a typo costs nothing.
    for (const value of ['abc', '-1', '1.5']) {
      expect(await main(['run', '--task', 'x', '--retries', value])).toBe(EXIT.usage);
    }
    expect(err.join('')).toContain('--retries');
  });

  it('documents the exit codes in --help', async () => {
    await main(['--help']);
    const help = out.join('');
    expect(help).toContain('0  the reviewers approved');
    expect(help).toContain('3  the reviewers did not approve');
  });

  it('prints a version', async () => {
    expect(await main(['--version'])).toBe(EXIT.ok);
    expect(out.join('').trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('rejects an unknown command with the usage code', async () => {
    expect(await main(['frobnicate'])).toBe(EXIT.usage);
    expect(err.join('')).toContain('unknown command "frobnicate"');
  });

  it('requires a task', async () => {
    expect(await main(['run'])).toBe(EXIT.usage);
    expect(err.join('')).toContain('--task');
  });

  it('rejects both --task and --task-file', async () => {
    expect(await main(['run', '--task', 'a', '--task-file', 'b'])).toBe(EXIT.usage);
    expect(err.join('')).toContain('not both');
  });

  it('rejects a non-numeric timeout', async () => {
    expect(await main(['run', '--task', 'a', '--timeout', 'soon'])).toBe(EXIT.usage);
    expect(err.join('')).toContain('--timeout');
  });

  it('needs a worker and at least one reviewer', async () => {
    expect(await main(['run', '--task', 'a', '--agents', 'claude'])).toBe(EXIT.usage);
    expect(err.join('')).toContain('at least one reviewer');
  });

  it('rejects a mode that is not one of the two, before opening anything', async () => {
    expect(await main(['run', '--task', 'a', '--mode', 'freeform'])).toBe(EXIT.usage);
    expect(err.join('')).toContain('--mode must be build-review or brainstorm');
  });

  it('rejects a --model that is not <runtime>=<model>', async () => {
    expect(await main(['run', '--task', 'a', '--model', 'opus'])).toBe(EXIT.usage);
    expect(err.join('')).toContain('--model takes <runtime>=<model>');
    expect(await main(['run', '--task', 'a', '--model', 'claude='])).toBe(EXIT.usage);
  });

  it('rejects an unknown flag rather than ignoring it', async () => {
    expect(await main(['run', '--task', 'a', '--frobnicate'])).toBe(EXIT.usage);
  });

  it('documents the surface: serve, worktrees, .acr.json, rooms, mode and models', async () => {
    await main(['--help']);
    const help = out.join('');
    expect(help).toContain('acr serve [--port N] [--no-open]');
    expect(help).toContain('127.0.0.1');
    expect(help).toContain('acr rooms ls | show <id> | export <id> | resume <id> | close <id>');
    expect(help).not.toContain('--rounds');
    expect(help).toContain('--no-worktree');
    expect(help).toContain('.acr.json');
    expect(help).toContain('--mode <mode>');
    expect(help).toContain('--model <rt>=<model>');
    expect(help).toContain('--out <path>');
  });

  it('understands the documented --no-* flags, which parseArgs alone does not', async () => {
    // `node:util`'s parseArgs answers "Unknown option '--no-open'"; every negative flag in
    // the help text has to keep working anyway.
    expect(await main(['serve', '--no-open', '--no-color'], { serve: fakeServe })).toBe(EXIT.ok);
    expect(served[0]?.open).toBe(false);

    // Not the same as a typo: an undeclared negation is still bad usage.
    expect(await main(['serve', '--no-frobnicate'], { serve: fakeServe })).toBe(EXIT.usage);

    // `--no-worktree` is documented for `run` too, and reached the same wall. It now gets
    // as far as the missing --task, which is the real complaint.
    err.length = 0;
    expect(await main(['run', '--no-worktree'])).toBe(EXIT.usage);
    expect(err.join('')).toContain('--task');
    expect(err.join('')).not.toContain('Unknown option');
  });

  it('rejects an unknown rooms subcommand with the usage code', async () => {
    expect(await main(['rooms', 'frobnicate'])).toBe(EXIT.usage);
    expect(err.join('')).toContain('unknown rooms subcommand');
  });
});
