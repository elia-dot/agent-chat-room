import { describe, expect, it } from 'vitest';

import {
  AntigravityParser,
  buildAgyArgs,
  buildAgyListModelsArgs,
  buildAgyPrompt,
  buildAgyStdin,
  parseAgyModels,
} from '../../src/adapters/antigravity.js';
import { antigravityAdapter } from '../../src/adapters/index.js';
import type { TurnRequest } from '../../src/types.js';
import { eventsOfType, fixtureLines, replay } from '../helpers.js';

const baseReq: TurnRequest = {
  cwd: '/repo',
  prompt: 'do the thing',
  permission: 'edits',
  timeoutMs: 1000,
};

describe('buildAgyArgs', () => {
  it('builds a streaming print run that reads its prompt from stdin', () => {
    expect(buildAgyArgs(baseReq)).toEqual([
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--disable-slash-commands',
      '--add-dir',
      '/repo',
      '--print-timeout',
      '1s',
      '--mode',
      'accept-edits',
      // `-p` takes a value, so the empty form is what turns print mode on without eating
      // the next flag as a prompt. It has to stay last for that to read clearly.
      '-p=',
    ]);
  });

  it('binds the turn to the repo with --add-dir', () => {
    // Probed against agy 1.1.26: with only the spawn `cwd` set the agent went looking
    // through `$HOME` and offered to write into `~/.gemini/antigravity-cli/scratch/`.
    // This flag is the difference between a turn in the repo and a turn somewhere else.
    expect(buildAgyArgs({ ...baseReq, cwd: '/some/other/repo' })).toEqual(
      expect.arrayContaining(['--add-dir', '/some/other/repo']),
    );
  });

  it('grants access to each additional folder', () => {
    expect(
      buildAgyArgs({
        ...baseReq,
        additionalDirs: ['/shared/docs', '/shared/data'],
      }),
    ).toEqual(
      expect.arrayContaining([
        '--add-dir',
        '/repo',
        '--add-dir',
        '/shared/docs',
        '--add-dir',
        '/shared/data',
      ]),
    );
  });

  it('derives --print-timeout from the turn timeout, overriding the agy 5m default', () => {
    const args = buildAgyArgs({ ...baseReq, timeoutMs: 1_800_000 });
    expect(args[args.indexOf('--print-timeout') + 1]).toBe('1800s');
    // Rounds up rather than down, so a sub-second timeout never becomes `0s`.
    const tiny = buildAgyArgs({ ...baseReq, timeoutMs: 250 });
    expect(tiny[tiny.indexOf('--print-timeout') + 1]).toBe('1s');
  });

  it('maps each permission level to the documented flags', () => {
    // Probed: `--sandbox` refused both a write and a redirecting shell command, while
    // `--mode accept-edits` wrote the file but auto-denied `run_command`.
    expect(buildAgyArgs({ ...baseReq, permission: 'read-only' })).toEqual(
      expect.arrayContaining(['--sandbox']),
    );
    expect(buildAgyArgs({ ...baseReq, permission: 'read-only' })).not.toContain('--mode');
    expect(buildAgyArgs({ ...baseReq, permission: 'edits' })).toEqual(
      expect.arrayContaining(['--mode', 'accept-edits']),
    );
    expect(buildAgyArgs({ ...baseReq, permission: 'full' })).toEqual(
      expect.arrayContaining(['--dangerously-skip-permissions']),
    );
  });

  it('resumes the conversation on a later turn, and passes a model through verbatim', () => {
    const args = buildAgyArgs({
      ...baseReq,
      sessionId: 'conv-9',
      model: 'gemini-3.1-pro-high',
    });
    expect(args).toEqual(expect.arrayContaining(['--conversation', 'conv-9']));
    expect(args).toEqual(expect.arrayContaining(['--model', 'gemini-3.1-pro-high']));
  });

  it('never asks for a structured output schema', () => {
    // `--json-schema` exists but only shapes the final text, and the `result` event has no
    // structured field to read back. The fenced verdict block is the contract instead.
    expect(buildAgyArgs({ ...baseReq, outputSchema: { type: 'object' } })).not.toContain(
      '--json-schema',
    );
    expect(antigravityAdapter.capabilities.structuredOutput).toBe(false);
  });
});

describe('buildAgyStdin', () => {
  it('emits exactly one NDJSON user message, the shape the CLI demands', () => {
    const stdin = buildAgyStdin(baseReq);
    expect(stdin.endsWith('\n')).toBe(true);
    const lines = stdin.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      event: 'user',
      message: { role: 'user', content: 'do the thing' },
    });
  });

  it('prepends role instructions on the first turn, since agy has no system flag', () => {
    const prompt = buildAgyPrompt({ ...baseReq, systemAppend: 'you are a reviewer' });
    expect(prompt.startsWith('you are a reviewer')).toBe(true);
    expect(prompt).toContain('do the thing');
  });

  it('does not repeat them on a resumed turn', () => {
    expect(
      buildAgyPrompt({ ...baseReq, systemAppend: 'you are a reviewer', sessionId: 'conv-9' }),
    ).toBe('do the thing');
  });

  it('carries a prompt of any size, because it goes on stdin rather than in argv', () => {
    // Plain stdin is not supported (agy answers `empty prompt`); the NDJSON envelope is the
    // only way in, and it is why a megabyte-scale room transcript never meets `ARG_MAX`.
    const huge = 'x'.repeat(1024 * 1024);
    const content = JSON.parse(buildAgyStdin({ ...baseReq, prompt: huge }).trim()) as {
      message: { content: string };
    };
    expect(content.message.content).toHaveLength(huge.length);
  });
});

describe('AntigravityParser over the recorded stream', () => {
  const lines = fixtureLines('agy_run.jsonl');

  it('reports the conversation from init and the final text from result', () => {
    const { events, result } = replay(new AntigravityParser(), lines);

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(eventsOfType(events, 'started')).toHaveLength(1);
    expect(result.text).toContain('```verdict');
    expect(result.text).toContain('math.js');
  });

  it('streams the answer as text deltas', () => {
    const { events } = replay(new AntigravityParser(), lines);
    const text = eventsOfType(events, 'text');
    expect(text.length).toBeGreaterThan(1);
    // Reasoning-only `agent_response` steps carry no delta, so the deltas reassemble into
    // exactly the message `result.response` reports.
    expect(text.map((e) => e.text).join('')).toBe(
      replay(new AntigravityParser(), lines).result.text,
    );
  });

  it('reports tool calls with their PascalCase parameters', () => {
    const { events } = replay(new AntigravityParser(), lines);
    const tools = eventsOfType(events, 'tool');
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['run_command', 'view_file']));
    expect(tools.some((t) => t.summary === 'ls -la')).toBe(true);
    expect(tools.some((t) => t.summary === '/repo/math.js')).toBe(true);
    // The reviewer only read, so no `file` event should have been invented.
    expect(eventsOfType(events, 'file')).toHaveLength(0);
  });

  it('normalises agy snake_case token counts from the run-cumulative result', () => {
    const { result } = replay(new AntigravityParser(), lines);
    expect(result.usage?.inputTokens).toBe(37716);
    expect(result.usage?.outputTokens).toBe(800);
    expect(result.usage?.cachedInputTokens).toBe(12190);
    // `total_tokens` is reported for the whole run, so it is used as it arrives.
    expect(result.usage?.totalTokens).toBe(38516);
  });

  it('emits exactly one done event, after the child exits', () => {
    const { events } = replay(new AntigravityParser(), lines);
    expect(eventsOfType(events, 'done')).toHaveLength(1);
  });
});

describe('AntigravityParser tolerance', () => {
  it('ignores the echoed prompt, system messages, unknown shapes and non-JSON noise', () => {
    const { events, result } = replay(new AntigravityParser(), [
      'jetski: a diagnostic line that is not an event',
      '{"event":"init","conversation_id":"c1","init":{"cwd":"/repo"}}',
      '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":0,"state":"DONE","step_type":"user_input"}}',
      '{"event":"step_update","step_update":{"conversation_id":"c1","state":"DONE","step_type":"system_message","text_delta":"chrome"}}',
      '{"event":"step_update","step_update":{"conversation_id":"c1","state":"DONE","step_type":"step_type_from_the_future"}}',
      '{"event":"telemetry_from_the_future","payload":{}}',
      '{"event":"step_update","step_update":{"conversation_id":"c1","state":"DONE","step_type":"agent_response","text_delta":"hi"}}',
      '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"hi"}}',
    ]);

    expect(result.ok).toBe(true);
    expect(result.text).toBe('hi');
    expect(eventsOfType(events, 'text').map((e) => e.text)).toEqual(['hi']);
    expect(eventsOfType(events, 'error')).toHaveLength(0);
  });

  it('reports a successful write tool as a file event', () => {
    const { events } = replay(new AntigravityParser(), [
      '{"event":"init","conversation_id":"c1","init":{"cwd":"/repo"}}',
      '{"event":"step_update","step_update":{"conversation_id":"c1","state":"DONE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"/repo/hello.txt"}}}}',
      '{"event":"step_update","step_update":{"conversation_id":"c1","state":"DONE","step_type":"tool","tool_name":"replace_file_content","tool_info":{"name":"replace_file_content","parameters":{"AbsolutePath":"/repo/math.js"}}}}',
      '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"done"}}',
    ]);
    expect(eventsOfType(events, 'file')).toEqual([
      { type: 'file', path: '/repo/hello.txt', op: 'create' },
      { type: 'file', path: '/repo/math.js', op: 'edit' },
    ]);
  });

  it('shows a denied tool as a failed call and invents no file event for it', () => {
    // The real shape of an `edits` turn trying to shell out, probed against agy 1.1.26.
    const { events } = replay(new AntigravityParser(), [
      '{"event":"init","conversation_id":"c1","init":{"cwd":"/repo"}}',
      '{"event":"step_update","step_update":{"conversation_id":"c1","state":"ERROR","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo SHELLRAN"},"error":{"type":"TOOL_ERROR","message":"permission check failed for command \\"echo SHELLRAN\\": user denied permission to run command"}}}}',
      '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"ok"}}',
    ]);
    const tools = eventsOfType(events, 'tool');
    expect(tools.some((t) => t.summary.includes('user denied permission'))).toBe(true);
    expect(eventsOfType(events, 'file')).toHaveLength(0);
  });

  it('fails the turn when agy exits non-zero with only stderr', () => {
    const { result } = replay(new AntigravityParser(), [], {
      exitCode: 1,
      stderr: 'something went wrong upstream',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('agy exited with code 1');
    expect(result.error).toContain('something went wrong upstream');
  });

  it('fails a turn whose result reports an error status', () => {
    const { result } = replay(new AntigravityParser(), [
      '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"the agent gave up"}}',
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('the agent gave up');
  });

  it('fails a cancelled turn even when agy says nothing about why', () => {
    const { result } = replay(new AntigravityParser(), [
      '{"event":"init","conversation_id":"c1","init":{"cwd":"/repo"}}',
      '{"event":"result","result":{"conversation_id":"c1","status":"CANCELED","response":""}}',
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('agy reported status CANCELED');
  });

  it('fails a successful-but-silent turn, naming the permission that blocked it', () => {
    // Probed: a denied tool ends the turn `SUCCESS` with an empty response. Posting that
    // as a message would put an empty bubble in the room, so it is a failure with a reason.
    const { result } = replay(new AntigravityParser(), [
      '{"event":"init","conversation_id":"c1","init":{"cwd":"/repo"}}',
      '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}',
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('agy produced no message');
    expect(result.error).toContain('RunCommand');
  });

  it('fails a turn that produced nothing at all', () => {
    const { result } = replay(new AntigravityParser(), []);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('agy produced no message');
  });
});

/** Real `agy models` output (1.1.26), trimmed, plus the banner it must skip. */
const LIST_MODELS_OUTPUT = [
  'Fetching available models...',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
  'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
  '',
].join('\n');

describe('listing antigravity models', () => {
  it('asks with the subcommand the CLI documents', () => {
    expect(buildAgyListModelsArgs()).toEqual(['models']);
  });

  it('reads the id and the label off each tab-separated row', () => {
    expect(parseAgyModels(LIST_MODELS_OUTPUT)).toEqual([
      { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
      { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
    ]);
  });

  it('skips the banner rather than inventing a model out of it', () => {
    const ids = parseAgyModels(LIST_MODELS_OUTPUT).map((m) => m.id);
    expect(ids).not.toContain('Fetching available models...');
    expect(ids.every((id) => !id.includes(' '))).toBe(true);
  });

  it('survives output with no models in it at all', () => {
    expect(parseAgyModels('')).toEqual([]);
    expect(parseAgyModels('Not logged in.\n')).toEqual([]);
  });

  it('keeps a static fallback for when the CLI cannot be asked', () => {
    expect(antigravityAdapter.capabilities.models).toContain('gemini-3.1-pro-high');
    expect(typeof antigravityAdapter.listModels).toBe('function');
  });
});

describe('a model antigravity rejects', () => {
  it('names the model and points at the picker', () => {
    // Replayed from the real `--model no-such-model-xyz` run: agy answers with an `ERROR`
    // result whose wording ("invalid model selection") the shared hint regex already covers.
    const { result } = replay(
      new AntigravityParser('no-such-model-xyz'),
      fixtureLines('agy_failed.jsonl'),
      { exitCode: 1 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid model selection');
    expect(result.error).toContain('"no-such-model-xyz"');
    expect(result.error).toContain('model list');
  });

  it('leaves an unrelated failure alone', () => {
    const { result } = replay(new AntigravityParser('gemini-3.1-pro-high'), [], {
      exitCode: 1,
      stderr: 'network unreachable',
    });
    expect(result.error).not.toContain('model list');
  });
});
