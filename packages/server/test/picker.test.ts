import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  pickFolder,
  pickerAvailability,
  PickerUnavailableError,
  type PickerRun,
  type PickResult,
} from '../src/picker.js';
import { ConflictError } from '../src/supervisor.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A `PATH` holding executables with these names and nothing else. */
function binDir(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'acr-picker-bin-'));
  dirs.push(dir);
  for (const name of names) {
    const path = join(dir, name);
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o755);
  }
  return dir;
}

function env(bins: string[], extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: binDir(...bins), ...extra };
}

interface Recorder {
  calls: { file: string; args: string[]; timeoutMs: number }[];
  run: PickerRun;
}

function recorder(result: Awaited<ReturnType<PickerRun>> | Error): Recorder {
  const calls: Recorder['calls'] = [];
  return {
    calls,
    run: (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
}

describe('native folder picker', () => {
  it('runs osascript on darwin with the start path as its own argument', async () => {
    const rec = recorder({ code: 0, stdout: '/Users/you/code/thing\n' });
    // A directory name that would be a syntax error if it were interpolated into the script.
    const nasty = '/tmp/we"ird\nname';
    const result = await pickFolder({
      platform: 'darwin',
      env: env(['osascript']),
      run: rec.run,
      startPath: nasty,
    });

    expect(result).toEqual({ path: '/Users/you/code/thing' });
    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0]!;
    expect(call.file.endsWith('/osascript')).toBe(true);
    expect(call.args[0]).toBe('-e');
    const script = call.args[1]!;
    expect(script).toContain('choose folder');
    expect(script).toContain('on run argv');
    // The whole point: the path is argv, never script text.
    expect(script).not.toContain(nasty);
    expect(script).not.toContain('we"ird');
    expect(call.args[2]).toBe(nasty);
  });

  it('brings the dialog to the front before asking', async () => {
    const rec = recorder({ code: 0, stdout: '/x\n' });
    await pickFolder({ platform: 'darwin', env: env(['osascript']), run: rec.run });
    // A `choose folder` that opens behind the browser window looks like a hang.
    expect(rec.calls[0]!.args[1]).toContain('activate');
    expect(pickerAvailability({ platform: 'darwin', env: env(['osascript']) })).toEqual({
      available: true,
      tool: 'osascript',
    });
  });

  it('prefers zenity on linux, falls back to kdialog, and needs a display', async () => {
    const display = { DISPLAY: ':0' };

    const zenity = recorder({ code: 0, stdout: '/home/you/code/thing\n' });
    await pickFolder({
      platform: 'linux',
      env: env(['zenity', 'kdialog'], display),
      run: zenity.run,
      startPath: '/home/you',
    });
    expect(zenity.calls[0]!.file.endsWith('/zenity')).toBe(true);
    expect(zenity.calls[0]!.args).toContain('--directory');
    expect(zenity.calls[0]!.args).toContain('--filename=/home/you/');

    const kdialog = recorder({ code: 0, stdout: '/home/you/other\n' });
    await pickFolder({
      platform: 'linux',
      env: env(['kdialog'], display),
      run: kdialog.run,
    });
    expect(kdialog.calls[0]!.file.endsWith('/kdialog')).toBe(true);
    expect(kdialog.calls[0]!.args[0]).toBe('--getexistingdirectory');

    expect(pickerAvailability({ platform: 'linux', env: env([], display) })).toEqual({
      available: false,
      tool: null,
    });
    // An SSH session has a zenity binary and nowhere to draw it.
    expect(pickerAvailability({ platform: 'linux', env: env(['zenity']) })).toEqual({
      available: false,
      tool: null,
    });
  });

  it('resolves powershell, then pwsh, on windows', async () => {
    const rec = recorder({ code: 0, stdout: 'C:\\code\\thing\r\n' });
    const result = await pickFolder({
      platform: 'win32',
      env: env(['powershell', 'pwsh']),
      run: rec.run,
    });
    expect(result).toEqual({ path: 'C:\\code\\thing' });
    expect(rec.calls[0]!.file.endsWith('powershell')).toBe(true);
    // Without a single-threaded apartment the dialog silently returns nothing.
    expect(rec.calls[0]!.args).toContain('-STA');

    expect(pickerAvailability({ platform: 'win32', env: env(['pwsh']) })).toEqual({
      available: true,
      tool: 'powershell',
    });
  });

  it('reads empty output as a dismissed dialog, whatever the exit code says', async () => {
    for (const code of [0, 1]) {
      const rec = recorder({ code, stdout: '  \n' });
      expect(
        await pickFolder({ platform: 'darwin', env: env(['osascript']), run: rec.run }),
      ).toEqual({ cancelled: true });
    }
  });

  it('throws when the dialog tool itself is broken', async () => {
    const odd = recorder({ code: 127, stdout: '' });
    await expect(
      pickFolder({ platform: 'darwin', env: env(['osascript']), run: odd.run }),
    ).rejects.toThrow('exited with 127');

    const dead = recorder(new Error('spawn ENOENT'));
    await expect(
      pickFolder({ platform: 'darwin', env: env(['osascript']), run: dead.run }),
    ).rejects.toThrow('ENOENT');
  });

  it('reports an abandoned dialog as cancelled rather than hanging forever', async () => {
    const rec = recorder({ timedOut: true });
    expect(
      await pickFolder({
        platform: 'darwin',
        env: env(['osascript']),
        run: rec.run,
        timeoutMs: 5,
      }),
    ).toEqual({ cancelled: true });
    expect(rec.calls[0]!.timeoutMs).toBe(5);
  });

  it('opens one dialog at a time and releases the lock either way', async () => {
    let release: (result: { code: number; stdout: string }) => void = () => undefined;
    const blocking: PickerRun = () =>
      new Promise((resolve) => {
        release = resolve;
      });

    const opts = { platform: 'darwin' as const, env: env(['osascript']), run: blocking };
    const first = pickFolder(opts);
    await expect(pickFolder(opts)).rejects.toBeInstanceOf(ConflictError);
    release({ code: 0, stdout: '/one\n' });
    expect(await first).toEqual<PickResult>({ path: '/one' });

    // Released after a success…
    const second = recorder({ code: 0, stdout: '/two\n' });
    expect(await pickFolder({ ...opts, run: second.run })).toEqual({ path: '/two' });

    // …and after a failure.
    const broken = recorder(new Error('boom'));
    await expect(pickFolder({ ...opts, run: broken.run })).rejects.toThrow('boom');
    const third = recorder({ code: 0, stdout: '/three\n' });
    expect(await pickFolder({ ...opts, run: third.run })).toEqual({ path: '/three' });
  });

  it('has nothing to offer when the host has no dialog, or the human opted out', async () => {
    expect(pickerAvailability({ platform: 'darwin', env: env([]) })).toEqual({
      available: false,
      tool: null,
    });
    expect(
      pickerAvailability({ platform: 'darwin', env: env(['osascript'], { ACR_NO_PICKER: '1' }) }),
    ).toEqual({ available: false, tool: null });

    await expect(
      pickFolder({ platform: 'darwin', env: env(['osascript'], { ACR_NO_PICKER: '1' }) }),
    ).rejects.toBeInstanceOf(PickerUnavailableError);
  });
});
