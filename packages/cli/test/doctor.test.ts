import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { doctor } from '../src/commands/doctor.js';
import { EXIT } from '../src/exit.js';
import { Renderer } from '../src/render.js';
import { Capture } from './helpers.js';

const savedPath = process.env.PATH;

beforeEach(() => {
  process.env.PATH = '/acr-nonexistent-path';
});

afterEach(() => {
  process.env.PATH = savedPath;
  vi.restoreAllMocks();
});

describe('acr doctor', () => {
  it('lists every runtime and fails when fewer than two are usable', async () => {
    const capture = new Capture();
    const code = await doctor({ renderer: new Renderer({ color: false, write: capture.write }) });
    expect(code).toBe(EXIT.internalError);

    const table = capture.text;
    expect(table).toContain('Claude Code');
    expect(table).toContain('Codex CLI');
    expect(table).toContain('Cursor Agent');
    expect(table).toContain('runtime');
    expect(table).toContain('installed');
    expect(table).toContain('acr needs at least 2');
  });

  it('emits machine readable output with --json', async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    await doctor({ json: true });
    const payload = JSON.parse(chunks.join('')) as {
      node: string;
      runtimes: { id: string; installed: boolean; usable: boolean }[];
    };
    expect(payload.node).toBe(process.version);
    expect(payload.runtimes.map((r) => r.id)).toEqual([
      'claude',
      'codex',
      'cursor',
      'antigravity',
      'echo',
    ]);
    expect(payload.runtimes.every((r) => r.installed === false)).toBe(true);
  });
});
