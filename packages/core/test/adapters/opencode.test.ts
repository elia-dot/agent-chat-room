import { describe, expect, it } from 'vitest';

import { opencodeAdapter } from '../../src/adapters/index.js';
import {
  OpencodeParser,
  buildOpencodeArgs,
  buildOpencodeEnv,
  buildOpencodeListModelsArgs,
  buildOpencodePrompt,
  parseOpencodeModels,
} from '../../src/adapters/opencode.js';
import type { TurnRequest } from '../../src/types.js';
import { eventsOfType, fixtureLines, replay } from '../helpers.js';

const baseReq: TurnRequest = {
  cwd: '/repo',
  prompt: 'do the thing',
  permission: 'edits',
  timeoutMs: 1000,
};

describe('buildOpencodeArgs', () => {
  it('builds a JSON run that reads its prompt from stdin', () => {
    expect(buildOpencodeArgs(baseReq)).toEqual(['run', '--format', 'json', '--auto']);
  });

  it('passes --auto at every level, so no turn can block on an approval prompt', () => {
    // The denials in `opencodePermissionConfig` outrank `--auto` – probed, and asserted in
    // permissions.test.ts. Without it a permission opencode defaults to `ask` would wedge a
    // headless turn until its stall timeout killed it.
    for (const permission of ['read-only', 'edits', 'full'] as const) {
      expect(buildOpencodeArgs({ ...baseReq, permission })).toContain('--auto');
    }
  });

  it('resumes a session with -s rather than starting a cold one', () => {
    expect(buildOpencodeArgs({ ...baseReq, sessionId: 'ses_abc' })).toEqual(
      expect.arrayContaining(['-s', 'ses_abc']),
    );
  });

  it('names the model when one was chosen and stays silent when none was', () => {
    expect(buildOpencodeArgs({ ...baseReq, model: 'opencode/claude-opus-5' })).toEqual(
      expect.arrayContaining(['-m', 'opencode/claude-opus-5']),
    );
    expect(buildOpencodeArgs(baseReq)).not.toContain('-m');
  });

  it('never asks for structured output, because there is no field to read it back from', () => {
    const args = buildOpencodeArgs({ ...baseReq, outputSchema: { type: 'object' } });
    expect(args.join(' ')).not.toContain('schema');
    expect(opencodeAdapter.capabilities.structuredOutput).toBe(false);
  });
});

describe('buildOpencodeEnv', () => {
  it('carries the permission table in OPENCODE_CONFIG_CONTENT', () => {
    const env = buildOpencodeEnv({ ...baseReq, permission: 'read-only' }, { PATH: '/usr/bin' });
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      permission: { edit: 'deny', bash: 'deny', webfetch: 'deny' },
    });
  });

  it('keeps the rest of the environment, because each CLI finds its own login there', () => {
    const env = buildOpencodeEnv(baseReq, { PATH: '/usr/bin', HOME: '/home/someone' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/someone');
  });

  it('gives a read-only turn no way to write, whatever the target repo asks for', () => {
    // Probed against opencode 1.18.20: `OPENCODE_CONFIG_CONTENT` beats the repo's own
    // `opencode.json`, so a repo committing `permission.edit: "allow"` cannot talk a
    // reviewer into editing. That precedence is the whole reason the table travels in the
    // environment instead of a file next to the code being reviewed.
    const env = buildOpencodeEnv({ ...baseReq, permission: 'read-only' });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}') as {
      permission: Record<string, string>;
    };
    expect(config.permission.edit).toBe('deny');
    expect(config.permission.bash).toBe('deny');
  });
});

describe('buildOpencodePrompt', () => {
  it('prepends role instructions on the first turn of a session', () => {
    const prompt = buildOpencodePrompt({ ...baseReq, systemAppend: 'You are a REVIEWER.' });
    expect(prompt).toBe('You are a REVIEWER.\n\n---\n\ndo the thing');
  });

  it('leaves a resumed turn alone, because the session already carries them', () => {
    const prompt = buildOpencodePrompt({
      ...baseReq,
      systemAppend: 'You are a REVIEWER.',
      sessionId: 'ses_abc',
    });
    expect(prompt).toBe('do the thing');
    expect(opencodeAdapter.capabilities.systemAppendDelivery).toBe('first-turn');
  });
});

describe('parseOpencodeModels', () => {
  it('takes the bare provider/model ids `opencode models` prints', () => {
    expect(
      parseOpencodeModels(
        'opencode/claude-opus-5\nopencode/gpt-5.6-sol\nanthropic/claude-sonnet-5',
      ),
    ).toEqual([
      { id: 'opencode/claude-opus-5' },
      { id: 'opencode/gpt-5.6-sol' },
      { id: 'anthropic/claude-sonnet-5' },
    ]);
  });

  it('skips prose, blanks and duplicates rather than inventing unselectable models', () => {
    // `readStdout` folds stderr in with stdout, so a warning can land in this stream.
    const out = [
      '',
      'Warning: could not reach the models endpoint',
      'opencode/claude-opus-5',
      'opencode/claude-opus-5',
      'not-a-model',
      'ollama/llama3.3:70b',
    ].join('\n');
    expect(parseOpencodeModels(out)).toEqual([
      { id: 'opencode/claude-opus-5' },
      { id: 'ollama/llama3.3:70b' },
    ]);
  });

  it('asks the CLI with the documented subcommand', () => {
    expect(buildOpencodeListModelsArgs()).toEqual(['models']);
  });
});

describe('OpencodeParser', () => {
  it('replays a recorded reviewer turn', () => {
    const { events, result } = replay(new OpencodeParser(), fixtureLines('opencode_run.jsonl'));

    expect(result.ok).toBe(true);
    // Every event carries a top-level `sessionID`, so the session is captured from the very
    // first line rather than waiting for a dedicated init event.
    expect(result.sessionId).toMatch(/^ses_/);
    expect(eventsOfType(events, 'started')).toHaveLength(1);
    expect(result.text).toMatch(/add\(\)/i);
    // The whole point of the exercise: the reviewer noticed `add()` subtracts.
    expect(result.text.toLowerCase()).toMatch(/subtract|incorrect|wrong|not correct/);
  });

  it('reports a denied tool under the name the model actually wanted', () => {
    // Recorded under the `read-only` config, where `bash` is withheld rather than refused.
    // opencode surfaces that as a synthetic tool called `invalid`; showing it as `bash`
    // is what makes "the reviewer tried to run the tests and could not" readable.
    const { events } = replay(new OpencodeParser(), fixtureLines('opencode_run.jsonl'));
    const blocked = eventsOfType(events, 'tool').filter((e) => e.summary.includes('blocked'));
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0]?.name).toBe('bash');
    expect(events.some((e) => e.type === 'tool' && e.name === 'invalid')).toBe(false);
  });

  it('emits no file events for a read-only turn', () => {
    const { events } = replay(new OpencodeParser(), fixtureLines('opencode_run.jsonl'));
    expect(eventsOfType(events, 'file')).toHaveLength(0);
  });

  it('adds usage up across steps rather than reporting only the last one', () => {
    // `step_finish` carries per-step tokens, so a turn that called tools reports several.
    const lines = [
      JSON.stringify({ type: 'step_start', sessionID: 'ses_1', part: {} }),
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_1',
        part: { tokens: { input: 100, output: 10, cache: { read: 5 } } },
      }),
      JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { text: 'done' } }),
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_1',
        part: { tokens: { input: 200, output: 20, cache: { read: 7 } } },
      }),
    ];
    const { result } = replay(new OpencodeParser(), lines);
    expect(result.usage).toEqual({
      inputTokens: 300,
      outputTokens: 30,
      cachedInputTokens: 12,
      totalTokens: 330,
    });
  });

  it('turns a recorded error into a failed turn', () => {
    // Recorded by asking for a model the account does not have. `error` is the one event
    // whose payload sits at the top level rather than under `part`.
    const { result } = replay(
      new OpencodeParser('opencode/does-not-exist-xyz'),
      fixtureLines('opencode_failed.jsonl'),
      { exitCode: 1 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('UnknownError');
    expect(result.error).toContain('Unexpected server error.');
  });

  it('cannot hint at a rejected model, because opencode does not say that is what happened', () => {
    // Worth pinning rather than hiding: opencode answers a bad `-m` with a generic
    // "Unexpected server error", the same thing it would say for a gateway outage. It
    // matches no rejection wording, so `withModelHint` stays quiet – and it should, because
    // guessing "your model is wrong" at every server error would be wrong half the time.
    // If opencode ever names the model, `modelHint.ts` starts firing and this test fails,
    // which is the notification we want.
    const { result } = replay(
      new OpencodeParser('opencode/does-not-exist-xyz'),
      fixtureLines('opencode_failed.jsonl'),
      { exitCode: 1 },
    );
    expect(result.error).not.toContain('Pick one from the model list');
  });

  it('survives noise instead of breaking on the next CLI upgrade', () => {
    const { result } = replay(new OpencodeParser(), [
      'not json at all',
      '',
      JSON.stringify({ type: 'step_start', sessionID: 'ses_1', part: {} }),
      JSON.stringify({ type: 'some_future_event', sessionID: 'ses_1', part: { wat: true } }),
      JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { text: 'still here' } }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('still here');
    expect(result.sessionId).toBe('ses_1');
  });

  it('fails a turn that produced no message at all', () => {
    const { result } = replay(new OpencodeParser(), [
      JSON.stringify({ type: 'step_start', sessionID: 'ses_1', part: {} }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no message');
  });

  it('fails a turn the engine cancelled, without inventing a reason', () => {
    const { result } = replay(
      new OpencodeParser(),
      [JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { text: 'partial' } })],
      { cancelled: true, exitCode: null },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('cancelled');
    // The partial answer is still handed back: it is real work the room can show.
    expect(result.text).toBe('partial');
  });
});

describe('the opencode adapter', () => {
  it('is registered under the id rooms store', () => {
    expect(opencodeAdapter.id).toBe('opencode');
    expect(opencodeAdapter.capabilities.resume).toBe(true);
    expect(opencodeAdapter.capabilities.readOnly).toBe(true);
  });

  it('reports itself missing rather than throwing when the CLI is not installed', async () => {
    const detection = await opencodeAdapter.detect();
    // Whichever machine this runs on, detection must answer without spawning a turn.
    expect(typeof detection.installed).toBe('boolean');
    if (!detection.installed) expect(detection.minVersionOk).toBe(false);
  });
});

describe('OpencodeParser text assembly', () => {
  it('streams the same message it stores, separator included', () => {
    // The room builds its live view from `text` deltas and its stored message from
    // `result.text`. If the join between two message parts lands in only one of them, the
    // transcript and the stream disagree about what the agent said.
    const lines = [
      JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { text: 'first' } }),
      JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { text: 'second' } }),
    ];
    const { events, result } = replay(new OpencodeParser(), lines);
    const streamed = eventsOfType(events, 'text')
      .map((e) => e.text)
      .join('');
    expect(streamed).toBe(result.text);
    expect(result.text).toBe('first\nsecond');
  });
});

describe('OpencodeParser tool summaries', () => {
  it('names what a call was for, not just what came back', () => {
    // opencode buffers a call and its result into a single event, so the summary has to
    // carry both halves or the transcript loses one of them.
    const { events } = replay(new OpencodeParser(), fixtureLines('opencode_run.jsonl'));
    const glob = eventsOfType(events, 'tool').find((e) => e.name === 'glob');
    if (glob) expect(glob.summary).toMatch(/ → /);

    const read = eventsOfType(events, 'tool').find((e) => e.name === 'read');
    expect(read?.summary).toContain('math.js');
    // `read` echoes `<path>…</path>` before the file body. The path is already on the left,
    // so the right-hand side must not repeat it.
    expect(read?.summary).not.toContain('<path>');
  });
});
