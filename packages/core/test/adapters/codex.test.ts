import { describe, expect, it } from 'vitest';

import {
  CodexParser,
  buildCodexArgs,
  buildCodexPrompt,
  codexAdapter,
  parseCodexModelsCache,
} from '../../src/adapters/codex.js';
import type { TurnRequest } from '../../src/types.js';
import { eventsOfType, fixtureLines, replay } from '../helpers.js';

const baseReq: TurnRequest = {
  cwd: '/repo',
  prompt: 'do the thing',
  permission: 'edits',
  timeoutMs: 1000,
};

describe('buildCodexArgs', () => {
  it('builds a fresh exec run with the working directory and sandbox', () => {
    expect(buildCodexArgs(baseReq)).toEqual([
      'exec',
      '--json',
      '-C',
      '/repo',
      '-s',
      'workspace-write',
      '--skip-git-repo-check',
      '--ignore-user-config',
    ]);
  });

  it('maps each permission level to the documented sandbox', () => {
    expect(buildCodexArgs({ ...baseReq, permission: 'read-only' })).toEqual(
      expect.arrayContaining(['-s', 'read-only']),
    );
    expect(buildCodexArgs({ ...baseReq, permission: 'full' })).toContain(
      '--dangerously-bypass-approvals-and-sandbox',
    );
  });

  it('switches to the resume subcommand, which takes neither -C nor -s', () => {
    const args = buildCodexArgs({ ...baseReq, sessionId: 'thread-9', permission: 'read-only' });
    expect(args.slice(0, 4)).toEqual(['exec', 'resume', 'thread-9', '-']);
    expect(args).not.toContain('-C');
    expect(args).not.toContain('-s');
    // The sandbox still has to be pinned, through the config key `-s` is sugar for.
    expect(args).toEqual(expect.arrayContaining(['-c', 'sandbox_mode="read-only"']));
  });

  it('passes a schema file only when one was written', () => {
    expect(buildCodexArgs(baseReq)).not.toContain('--output-schema');
    expect(buildCodexArgs(baseReq, { schemaPath: '/tmp/s.json' })).toEqual(
      expect.arrayContaining(['--output-schema', '/tmp/s.json']),
    );
  });

  it('puts additional folders before the subcommand so resume accepts the global flag', () => {
    const args = buildCodexArgs({
      ...baseReq,
      sessionId: 'thread-9',
      additionalDirs: ['/shared/docs', '/shared/data'],
    });
    expect(args.slice(0, 8)).toEqual([
      '--add-dir',
      '/shared/docs',
      '--add-dir',
      '/shared/data',
      'exec',
      'resume',
      'thread-9',
      '-',
    ]);
  });
});

describe('buildCodexPrompt', () => {
  it('prepends role instructions on the first turn, since codex has no system flag', () => {
    const prompt = buildCodexPrompt({ ...baseReq, systemAppend: 'you are a reviewer' });
    expect(prompt.startsWith('you are a reviewer')).toBe(true);
    expect(prompt).toContain('do the thing');
  });

  it('does not repeat them on a resumed turn', () => {
    const prompt = buildCodexPrompt({
      ...baseReq,
      systemAppend: 'you are a reviewer',
      sessionId: 'thread-9',
    });
    expect(prompt).toBe('do the thing');
  });
});

describe('CodexParser against a recorded run (codex-cli 0.152.1)', () => {
  const lines = fixtureLines('codex_run.jsonl');

  it('extracts the thread id as the session id', () => {
    const { events, result } = replay(new CodexParser(), lines);
    expect(eventsOfType(events, 'started')[0]?.sessionId).toBe(
      '01a0654d-3f2d-78b3-a19d-6ba2883af31d',
    );
    expect(result.sessionId).toBe('01a0654d-3f2d-78b3-a19d-6ba2883af31d');
  });

  it('takes the final text from the last agent_message, not from turn.completed', () => {
    const { result } = replay(new CodexParser(), lines);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('```verdict');
    expect(result.text).toContain('incorrectly subtracts');
  });

  it('reports usage and command activity', () => {
    const { events, result } = replay(new CodexParser(), lines);
    expect(result.usage?.inputTokens).toBe(30391);
    expect(result.usage?.outputTokens).toBe(144);
    expect(result.usage?.cachedInputTokens).toBe(22272);
    const tools = eventsOfType(events, 'tool');
    expect(tools.some((t) => t.summary.includes('sed -n') && t.summary.includes('exit 0'))).toBe(
      true,
    );
  });

  it('emits one tool event per completed command, not one per update', () => {
    const { events } = replay(new CodexParser(), lines);
    expect(eventsOfType(events, 'tool').filter((t) => t.name === 'bash')).toHaveLength(1);
  });
});

describe('CodexParser against a recorded failure', () => {
  const lines = fixtureLines('codex_failed.jsonl');

  it('fails the turn on turn.failed', () => {
    const { result } = replay(new CodexParser(), lines, { exitCode: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not supported when using Codex with a ChatGPT account');
  });

  it('downgrades the transient fallback warning to activity rather than failing on it', () => {
    const { events } = replay(new CodexParser(), lines, { exitCode: 1 });
    const activity = eventsOfType(events, 'tool');
    expect(activity.some((t) => t.summary.includes('fallback metadata'))).toBe(true);
  });

  it('does not fail a turn on a mid-turn retry notice alone', () => {
    const { result } = replay(new CodexParser(), [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'error', message: 'stream disconnected, retrying in 2s' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i', type: 'agent_message', text: 'all good' },
      }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('all good');
  });

  it('reports file changes so the engine can show what moved', () => {
    const { events } = replay(new CodexParser(), [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'i',
          type: 'file_change',
          changes: [
            { path: 'src/a.ts', kind: 'edit' },
            { path: 'src/b.ts', kind: 'add' },
          ],
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'j', type: 'agent_message', text: 'done' },
      }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ]);
    expect(eventsOfType(events, 'file')).toEqual([
      { type: 'file', path: 'src/a.ts', op: 'edit' },
      { type: 'file', path: 'src/b.ts', op: 'create' },
    ]);
  });

  it('drops reasoning items, which are not the message', () => {
    const { events } = replay(new CodexParser(), [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i', type: 'reasoning', text: 'thinking out loud at length' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'j', type: 'agent_message', text: 'done' },
      }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ]);
    expect(eventsOfType(events, 'text').map((e) => e.text)).toEqual(['done']);
  });
});

describe('a model codex rejects', () => {
  it('names the model and points at the picker', () => {
    const { result } = replay(new CodexParser('gpt-9'), [
      JSON.stringify({ type: 'turn.failed', error: { message: 'model_not_found: gpt-9' } }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('"gpt-9"');
    expect(result.error).toContain('model list');
  });

  it('has valid fallback slugs and reads Codex account-specific models when available', () => {
    expect(codexAdapter.capabilities.models).toContain('gpt-5.6-sol');
    expect(codexAdapter.capabilities.models).not.toContain('gpt-5.3-codex-xhigh');
    expect(codexAdapter).toHaveProperty('listModels');
  });
});

describe('parseCodexModelsCache', () => {
  it('returns only visible account models with their display names', () => {
    expect(
      parseCodexModelsCache(
        JSON.stringify({
          models: [
            { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list' },
            { slug: 'codex-auto-review', display_name: 'Auto Review', visibility: 'hide' },
            { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list' },
          ],
        }),
      ),
    ).toEqual([
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
    ]);
  });

  it('ignores malformed caches and duplicate slugs', () => {
    expect(parseCodexModelsCache('not json')).toEqual([]);
    expect(
      parseCodexModelsCache(
        JSON.stringify({
          models: [
            { slug: 'gpt-5.5', visibility: 'list' },
            { slug: 'gpt-5.5', display_name: 'duplicate', visibility: 'list' },
            { slug: '', visibility: 'list' },
          ],
        }),
      ),
    ).toEqual([{ id: 'gpt-5.5' }]);
  });
});
