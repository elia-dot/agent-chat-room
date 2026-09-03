import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudeAdapter } from '../src/adapters/claude.js';
import { codexAdapter } from '../src/adapters/codex.js';
import {
  compareVersions,
  credentialPresent,
  extractVersion,
  meetsMinVersion,
  which,
} from '../src/detect.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acr-detect-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('which', () => {
  it('finds an executable on a stubbed PATH', () => {
    const bin = join(dir, 'fakecli');
    writeFileSync(bin, '#!/bin/sh\necho 1.2.3\n');
    chmodSync(bin, 0o755);
    expect(which('fakecli', { PATH: dir })).toBe(bin);
  });

  it('returns undefined when nothing on PATH matches', () => {
    expect(which('fakecli', { PATH: dir })).toBeUndefined();
  });

  it('ignores a non-executable file of the right name', () => {
    const bin = join(dir, 'fakecli');
    writeFileSync(bin, 'not executable');
    chmodSync(bin, 0o644);
    expect(which('fakecli', { PATH: dir })).toBeUndefined();
  });
});

describe('version helpers', () => {
  it('pulls a version out of whatever a CLI prints', () => {
    expect(extractVersion('2.1.259 (Claude Code)')).toBe('2.1.259');
    expect(extractVersion('codex-cli 0.152.1')).toBe('0.152.1');
    expect(extractVersion('cursor-agent 2026.07.23')).toBe('2026.07.23');
    expect(extractVersion('no version here')).toBeUndefined();
  });

  it('orders versions numerically, not lexically', () => {
    expect(compareVersions('2.1.259', '2.1.9')).toBe(1);
    expect(compareVersions('0.152.1', '0.150.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0', '1.0.1')).toBe(-1);
  });

  it('treats an unknown version as not meeting the minimum', () => {
    expect(meetsMinVersion(undefined, '2.0.0')).toBe(false);
    expect(meetsMinVersion('2.1.259', '2.0.0')).toBe(true);
    expect(meetsMinVersion('1.9.0', '2.0.0')).toBe(false);
  });
});

describe('credentialPresent', () => {
  it('reports presence without reading the file', () => {
    const creds = join(dir, 'auth.json');
    expect(credentialPresent([creds])).toBe(false);
    writeFileSync(creds, 'this content is never read');
    expect(credentialPresent([creds])).toBe(true);
  });

  it('is undefined when there is nothing to check', () => {
    expect(credentialPresent([])).toBeUndefined();
  });
});

describe('adapter detect()', () => {
  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  const savedCodexHome = process.env.CODEX_HOME;

  afterEach(() => {
    process.env.PATH = savedPath;
    process.env.HOME = savedHome;
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
  });

  it('reports a missing runtime without spawning anything', async () => {
    process.env.PATH = join(dir, 'empty');
    const detection = await claudeAdapter.detect();
    expect(detection).toEqual({
      installed: false,
      minVersionOk: false,
      note: '`claude` is not on your PATH',
    });
  });

  it('probes codex credentials by presence only, never by running codex', async () => {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    // A stub that would fail loudly if detection ever ran it for anything but --version.
    const bin = join(binDir, 'codex');
    writeFileSync(
      bin,
      '#!/bin/sh\nif [ "$1" != "--version" ]; then exit 99; fi\necho "codex-cli 0.152.1"\n',
    );
    chmodSync(bin, 0o755);

    const codexHome = join(dir, 'codex-home');
    mkdirSync(codexHome);
    process.env.PATH = binDir;
    process.env.CODEX_HOME = codexHome;

    const before = await codexAdapter.detect();
    expect(before.installed).toBe(true);
    expect(before.version).toBe('0.152.1');
    expect(before.minVersionOk).toBe(true);
    expect(before.loggedIn).toBe(false);

    writeFileSync(join(codexHome, 'auth.json'), '{"never":"read"}');
    const after = await codexAdapter.detect();
    expect(after.loggedIn).toBe(true);
  });

  it('flags a runtime that is installed but too old', async () => {
    const binDir = join(dir, 'bin-old');
    mkdirSync(binDir);
    const bin = join(binDir, 'claude');
    writeFileSync(bin, '#!/bin/sh\necho "1.0.0 (Claude Code)"\n');
    chmodSync(bin, 0o755);
    process.env.PATH = binDir;
    process.env.HOME = dir;

    const detection = await claudeAdapter.detect();
    expect(detection.installed).toBe(true);
    expect(detection.minVersionOk).toBe(false);
    expect(detection.note).toContain('needs >=');
  });
});
