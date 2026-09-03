import { describe, expect, it } from 'vitest';

import { notify } from '../src/notify.js';

function recorder(): { calls: [string, string[]][]; spawn: (f: string, a: string[]) => void } {
  const calls: [string, string[]][] = [];
  return { calls, spawn: (file, args) => calls.push([file, args]) };
}

describe('desktop notifications', () => {
  it('spawns osascript on darwin and nothing anywhere else', () => {
    const mac = recorder();
    expect(
      notify('Approved: Fix add()', 'Every reviewer approved round 2.', {
        platform: 'darwin',
        spawn: mac.spawn,
        disabled: false,
      }),
    ).toBe(true);
    expect(mac.calls).toHaveLength(1);
    expect(mac.calls[0]![0]).toBe('osascript');
    expect(mac.calls[0]![1][0]).toBe('-e');
    expect(mac.calls[0]![1][1]).toContain('display notification');
    expect(mac.calls[0]![1][1]).toContain('Fix add()');

    for (const platform of ['linux', 'win32'] as const) {
      const other = recorder();
      expect(notify('t', 'b', { platform, spawn: other.spawn, disabled: false })).toBe(false);
      expect(other.calls).toEqual([]);
    }
  });

  it('does nothing when notifications are turned off', () => {
    const off = recorder();
    expect(notify('t', 'b', { platform: 'darwin', spawn: off.spawn, disabled: true })).toBe(false);
    expect(off.calls).toEqual([]);
  });

  it('escapes a title that would otherwise be an AppleScript syntax error', () => {
    const mac = recorder();
    notify('He said "ship it"', 'line one\nline two', {
      platform: 'darwin',
      spawn: mac.spawn,
      disabled: false,
    });
    const script = mac.calls[0]![1][1]!;
    expect(script).toContain('\\"ship it\\"');
    // A newline inside an AppleScript string literal does not parse.
    expect(script).not.toContain('\n');
  });
});
