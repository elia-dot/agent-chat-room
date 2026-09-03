import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXIT } from '../src/exit.js';
import { main } from '../src/main.js';

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
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
  it('prints help with no arguments, since the UI is M2', async () => {
    expect(await main([])).toBe(EXIT.ok);
    expect(out.join('')).toContain('acr doctor');
    expect(out.join('')).toContain('milestone M2');
  });

  it('documents the exit codes in --help', async () => {
    await main(['--help']);
    const help = out.join('');
    expect(help).toContain('0  the reviewer approved');
    expect(help).toContain('3  the reviewer did not approve');
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

  it('requires exactly two agents in M0', async () => {
    expect(await main(['run', '--task', 'a', '--agents', 'claude'])).toBe(EXIT.usage);
    expect(err.join('')).toContain('exactly two runtimes');
  });

  it('rejects an unknown flag rather than ignoring it', async () => {
    expect(await main(['run', '--task', 'a', '--rounds', '4'])).toBe(EXIT.usage);
  });
});
