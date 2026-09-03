import { describe, expect, it } from 'vitest';

import { CursorParser, buildCursorArgs, buildCursorPrompt } from '../../src/adapters/cursor.js';
import { cursorAdapter } from '../../src/adapters/index.js';
import type { TurnRequest } from '../../src/types.js';
import { eventsOfType, fixtureLines, replay } from '../helpers.js';

const baseReq: TurnRequest = {
  cwd: '/repo',
  prompt: 'do the thing',
  permission: 'edits',
  timeoutMs: 1000,
};

describe('buildCursorArgs', () => {
  it('builds a streaming print run pointed at the workspace', () => {
    expect(buildCursorArgs(baseReq)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--trust',
      '--workspace',
      '/repo',
    ]);
  });

  it('maps each permission level to the documented flags', () => {
    // Probed against cursor-agent 2026.07.23: in `ask` mode a turn asked to create a file
    // refuses, and even a read-only shell command comes back `permissionDenied`.
    expect(buildCursorArgs({ ...baseReq, permission: 'read-only' })).toEqual(
      expect.arrayContaining(['--mode', 'ask', '--sandbox', 'enabled', '--trust']),
    );
    expect(buildCursorArgs({ ...baseReq, permission: 'edits' })).not.toContain('--mode');
    expect(buildCursorArgs({ ...baseReq, permission: 'full' })).toEqual(
      expect.arrayContaining(['--force', '--trust']),
    );
  });

  it('resumes the chat on a later turn, and passes a model through verbatim', () => {
    // Cursor models are parameterised strings, so the field has to stay free text.
    const args = buildCursorArgs({
      ...baseReq,
      sessionId: 'chat-9',
      model: 'claude-opus-4-8[context=1m,effort=high]',
    });
    expect(args).toEqual(expect.arrayContaining(['--resume', 'chat-9']));
    expect(args).toEqual(
      expect.arrayContaining(['--model', 'claude-opus-4-8[context=1m,effort=high]']),
    );
  });

  it('never asks for a structured output schema, because cursor-agent has none', () => {
    expect(buildCursorArgs({ ...baseReq, outputSchema: { type: 'object' } })).not.toContain(
      '--output-schema',
    );
    expect(cursorAdapter.capabilities.structuredOutput).toBe(false);
  });
});

describe('buildCursorPrompt', () => {
  it('prepends role instructions on the first turn, since cursor has no system flag', () => {
    const prompt = buildCursorPrompt({ ...baseReq, systemAppend: 'you are a reviewer' });
    expect(prompt.startsWith('you are a reviewer')).toBe(true);
    expect(prompt).toContain('do the thing');
  });

  it('does not repeat them on a resumed turn', () => {
    expect(
      buildCursorPrompt({ ...baseReq, systemAppend: 'you are a reviewer', sessionId: 'chat-9' }),
    ).toBe('do the thing');
  });

  it('carries a prompt of any size, because it goes on stdin rather than in argv', () => {
    // Probed: `cursor-agent -p` with no positional prompt reads stdin and answers normally.
    // That is why there is no argv size guard here – a room transcript can be megabytes.
    const huge = 'x'.repeat(2 * 1024 * 1024);
    expect(buildCursorPrompt({ ...baseReq, prompt: huge })).toHaveLength(huge.length);
  });
});

describe('CursorParser over the recorded stream', () => {
  const lines = fixtureLines('cursor_run.jsonl');

  it('reports the session from system/init and the final text from result', () => {
    const { events, result } = replay(new CursorParser(), lines);

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('11111111-2222-3333-4444-555555555555');
    expect(eventsOfType(events, 'started')).toHaveLength(1);
    expect(result.text).toContain('```verdict');
    expect(result.text).toContain('math.js:2');
  });

  it('streams the answer as text deltas', () => {
    const { events } = replay(new CursorParser(), lines);
    const text = eventsOfType(events, 'text');
    expect(text.length).toBeGreaterThan(10);
    expect(text.map((e) => e.text).join('')).toContain('math.js');
  });

  it('reports tool calls, including one the permission layer refused', () => {
    const { events } = replay(new CursorParser(), lines);
    const tools = eventsOfType(events, 'tool');
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['glob', 'shell', 'read']));
    // The read-only reviewer's shell command was blocked, and that has to be visible.
    expect(tools.some((t) => t.summary.includes('permissionDenied'))).toBe(true);
    // Nothing was written, so no `file` event should have been invented.
    expect(eventsOfType(events, 'file')).toHaveLength(0);
  });

  it('normalises cursor camelCase token counts', () => {
    const { result } = replay(new CursorParser(), lines);
    expect(result.usage?.inputTokens).toBe(25404);
    expect(result.usage?.outputTokens).toBe(317);
    expect(result.usage?.cachedInputTokens).toBe(19200);
    expect(result.usage?.totalTokens).toBe(25404 + 317);
  });

  it('emits exactly one done event, after the child exits', () => {
    const { events } = replay(new CursorParser(), lines);
    expect(eventsOfType(events, 'done')).toHaveLength(1);
  });
});

describe('CursorParser tolerance', () => {
  it('ignores thinking, the echoed user prompt, unknown types and non-JSON noise', () => {
    const { events, result } = replay(new CursorParser(), [
      'npm notice a new version is available',
      '{"type":"system","subtype":"init","session_id":"s1"}',
      '{"type":"user","message":{"content":[{"type":"text","text":"the prompt"}]}}',
      '{"type":"thinking","subtype":"delta","text":"hmm"}',
      '{"type":"telemetry_event_from_the_future","payload":{}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"hi","session_id":"s1"}',
    ]);

    expect(result.ok).toBe(true);
    expect(result.text).toBe('hi');
    expect(eventsOfType(events, 'text').map((e) => e.text)).toEqual(['hi']);
    expect(eventsOfType(events, 'error')).toHaveLength(0);
  });

  it('reports a write tool as a file event', () => {
    const { events } = replay(new CursorParser(), [
      '{"type":"system","subtype":"init","session_id":"s1"}',
      '{"type":"tool_call","subtype":"completed","tool_call":{"writeToolCall":{"args":{"path":"/repo/math.js"},"result":{"success":{}}}}}',
      '{"type":"result","subtype":"success","result":"done","session_id":"s1"}',
    ]);
    expect(eventsOfType(events, 'file')).toEqual([
      { type: 'file', path: '/repo/math.js', op: 'edit' },
    ]);
  });

  it('fails the turn when cursor-agent exits non-zero with only stderr', () => {
    // What a bad `--model` actually does: nothing on stdout, the reason on stderr, exit 1.
    const { result } = replay(new CursorParser(), [], {
      exitCode: 1,
      stderr: 'Cannot use this model: no-such-model-xyz',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('cursor-agent exited with code 1');
    expect(result.error).toContain('no-such-model-xyz');
  });

  it('fails a turn that produced a result event saying it errored', () => {
    const { result } = replay(new CursorParser(), [
      '{"type":"system","subtype":"init","session_id":"s1"}',
      '{"type":"result","subtype":"error","is_error":true,"result":"the agent gave up","session_id":"s1"}',
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('the agent gave up');
  });

  it('fails a silent turn rather than posting an empty message', () => {
    const { result } = replay(new CursorParser(), []);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('cursor-agent produced no message');
  });
});
