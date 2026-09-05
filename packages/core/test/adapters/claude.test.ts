import { describe, expect, it } from 'vitest';

import { ClaudeParser, buildClaudeArgs, claudeAdapter } from '../../src/adapters/claude.js';
import type { TurnRequest } from '../../src/types.js';
import { eventsOfType, fixtureLines, replay } from '../helpers.js';

const baseReq: TurnRequest = {
  cwd: '/repo',
  prompt: 'do the thing',
  permission: 'edits',
  timeoutMs: 1000,
};

describe('buildClaudeArgs', () => {
  it('always runs headless stream-json with project settings only', () => {
    const args = buildClaudeArgs(baseReq);
    expect(args.slice(0, 6)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      'project',
    ]);
  });

  it('maps each permission level to the documented flags', () => {
    expect(buildClaudeArgs({ ...baseReq, permission: 'read-only' })).toContain('plan');
    expect(buildClaudeArgs({ ...baseReq, permission: 'read-only' })).toEqual(
      expect.arrayContaining(['--tools', 'Read,Glob,Grep']),
    );
    expect(buildClaudeArgs({ ...baseReq, permission: 'edits' })).toEqual(
      expect.arrayContaining(['--permission-mode', 'acceptEdits']),
    );
    expect(buildClaudeArgs({ ...baseReq, permission: 'full' })).toEqual(
      expect.arrayContaining(['--permission-mode', 'bypassPermissions']),
    );
    expect(buildClaudeArgs({ ...baseReq, permission: 'edits' })).not.toContain('--tools');
  });

  it('adds resume, model, system prompt and schema only when asked', () => {
    expect(buildClaudeArgs(baseReq)).not.toContain('--resume');
    const args = buildClaudeArgs({
      ...baseReq,
      sessionId: 'sess-1',
      model: 'opus',
      systemAppend: 'you are a reviewer',
      outputSchema: { type: 'object' },
    });
    expect(args).toEqual(expect.arrayContaining(['--resume', 'sess-1']));
    expect(args).toEqual(expect.arrayContaining(['--model', 'opus']));
    expect(args).toEqual(expect.arrayContaining(['--append-system-prompt', 'you are a reviewer']));
    expect(args[args.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
  });

  it('grants every additional folder to fresh and resumed turns', () => {
    const args = buildClaudeArgs({
      ...baseReq,
      sessionId: 'sess-1',
      additionalDirs: ['/shared/docs', '/shared/data'],
    });
    expect(args).toEqual(
      expect.arrayContaining(['--add-dir', '/shared/docs', '/shared/data', '--resume', 'sess-1']),
    );
  });
});

describe('ClaudeParser against a recorded run (claude 2.1.259)', () => {
  const lines = fixtureLines('claude_run.jsonl');

  it('extracts the session id from the stream', () => {
    const { events, result } = replay(new ClaudeParser(), lines);
    const started = eventsOfType(events, 'started');
    expect(started).toHaveLength(1);
    expect(started[0]?.sessionId).toBe('4ccbd27b-c1b1-45a9-b12c-46fdcb6a1d1d');
    expect(result.sessionId).toBe(started[0]?.sessionId);
  });

  it('reports the final text and usage from the result event', () => {
    const { events, result } = replay(new ClaudeParser(), lines);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('```verdict');
    expect(result.usage?.inputTokens).toBe(6);
    expect(result.usage?.outputTokens).toBe(218);
    expect(result.usage?.cachedInputTokens).toBe(68800);
    const done = eventsOfType(events, 'done');
    expect(done).toHaveLength(1);
    expect(done[0]?.text).toBe(result.text);
  });

  it('captures a schema-validated structured output separately from the prose', () => {
    const structured = { decision: 'approve', blocking: [], nits: [] };
    const { result } = replay(new ClaudeParser(), [
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'The prose has malformed JSON.',
        structured_output: structured,
        session_id: 's',
      }),
    ]);
    expect(result.structured).toEqual(structured);
  });

  it('surfaces tool calls and their results', () => {
    const { events } = replay(new ClaudeParser(), lines);
    const tools = eventsOfType(events, 'tool');
    expect(tools.map((t) => t.name)).toContain('Glob');
    expect(tools.map((t) => t.name)).toContain('Read');
    // Every tool_use is matched by a `-> ...` summary from its tool_result.
    expect(tools.filter((t) => t.summary.startsWith('→')).length).toBeGreaterThan(0);
  });
});

describe('ClaudeParser tolerance', () => {
  const lines = fixtureLines('claude_noise.jsonl');

  it('ignores hook events, unknown types and non-JSON log lines', () => {
    const { events, result } = replay(new ClaudeParser(), lines);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('done');
    expect(eventsOfType(events, 'error')).toHaveLength(0);
    expect(eventsOfType(events, 'started')[0]?.sessionId).toBe('noise-session-1');
  });

  it('emits a file event when a write tool touches a path', () => {
    const parser = new ClaudeParser();
    const { events } = replay(parser, [
      JSON.stringify({
        type: 'assistant',
        session_id: 's',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Edit',
              input: { file_path: 'src/a.ts', old_string: 'a' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        session_id: 's',
      }),
    ]);
    expect(eventsOfType(events, 'file')).toEqual([{ type: 'file', path: 'src/a.ts', op: 'edit' }]);
  });

  it('fails the turn when the result event reports an error', () => {
    const { result } = replay(new ClaudeParser(), [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'boom',
        session_id: 's',
      }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('boom');
  });

  it('fails the turn when the binary is missing', () => {
    const { result } = replay(new ClaudeParser(), [], {
      exitCode: null,
      spawnError: 'claude is not on your PATH.',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not on your PATH');
  });
});

describe('a model claude rejects', () => {
  /** The `result` line a real `claude --model opus-5` run emits (claude 2.1.259). */
  const rejection = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 404,
    session_id: 's',
    result:
      "There's an issue with the selected model (opus-5). It may not exist or you may not " +
      'have access to it. Run --model to pick a different model.',
  });

  it('keeps the CLI sentence and adds where to fix it', () => {
    const { result } = replay(new ClaudeParser('opus-5'), [rejection], { exitCode: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('It may not exist');
    expect(result.error).toContain('"opus-5"');
    expect(result.error).toContain('model list');
  });

  it('says nothing extra when the turn failed for another reason', () => {
    const { result } = replay(new ClaudeParser('opus'), [
      JSON.stringify({ type: 'result', is_error: true, result: 'boom', session_id: 's' }),
    ]);
    expect(result.error).toBe('boom');
  });

  it('offers the aliases the installed CLI documents', () => {
    expect(claudeAdapter.capabilities.models).toEqual(
      expect.arrayContaining(['opus', 'sonnet', 'haiku', 'fable']),
    );
    expect(claudeAdapter.capabilities.models).not.toContain('opus-5');
  });
});
