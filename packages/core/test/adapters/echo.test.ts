import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { echoAdapter, resetEchoAdapter } from '../../src/adapters/echo.js';
import type { TurnEvent } from '../../src/types.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acr-echo-'));
  resetEchoAdapter();
});

afterEach(() => {
  delete process.env.ACR_ECHO_SCRIPT;
  rmSync(dir, { recursive: true, force: true });
  resetEchoAdapter();
});

function script(turns: unknown[]): void {
  const path = join(dir, 'script.json');
  writeFileSync(path, JSON.stringify({ turns }));
  process.env.ACR_ECHO_SCRIPT = path;
}

function collect(): { events: TurnEvent[]; sink: (e: TurnEvent) => void } {
  const events: TurnEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

describe('the echo adapter', () => {
  it('is only detected when a script is configured', async () => {
    expect((await echoAdapter.detect()).installed).toBe(false);
    script([]);
    expect((await echoAdapter.detect()).installed).toBe(true);
  });

  it('replays turns in order and writes the files a scripted worker "edits"', async () => {
    script([{ text: 'first', writeFiles: { 'a.txt': 'hello' } }, { text: 'second' }]);
    const one = collect();
    const first = await echoAdapter.run(
      { cwd: dir, prompt: 'p', permission: 'edits', timeoutMs: 1000 },
      one.sink,
    ).done;
    expect(first.text).toBe('first');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('hello');
    expect(one.events.map((e) => e.type)).toEqual(['started', 'file', 'text', 'done']);

    const two = collect();
    const second = await echoAdapter.run(
      { cwd: dir, prompt: 'p', permission: 'edits', timeoutMs: 1000 },
      two.sink,
    ).done;
    expect(second.text).toBe('second');
  });

  it('fails loudly when the script runs out of turns', async () => {
    script([]);
    const { sink } = collect();
    const result = await echoAdapter.run(
      { cwd: dir, prompt: 'p', permission: 'edits', timeoutMs: 1000 },
      sink,
    ).done;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no scripted turn');
  });

  it('settles when a delayed turn is cancelled, instead of hanging', async () => {
    script([{ text: 'slow', delayMs: 60_000 }]);
    const { sink } = collect();
    const handle = echoAdapter.run(
      { cwd: dir, prompt: 'p', permission: 'edits', timeoutMs: 1000 },
      sink,
    );
    handle.cancel();
    const result = await handle.done;
    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
  });
});
