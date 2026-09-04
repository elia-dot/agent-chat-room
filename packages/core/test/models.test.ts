import { beforeEach, describe, expect, it } from 'vitest';

import { listAllModels, listModels, modelRejectionHint, resetModelCache } from '../src/models.js';
import type { AgentAdapter, Detection, ModelOption } from '../src/types.js';

/** The claude 2.1.259 result text, copied from a real `--model opus-5` run. */
const CLAUDE_404 =
  "There's an issue with the selected model (opus-5). It may not exist or you may not have access to it. Run --model to pick a different model.";

interface StubOptions {
  installed?: boolean;
  models?: string[];
  list?: () => Promise<ModelOption[]>;
}

let nextId = 0;

/** A minimal adapter: `models.ts` only ever touches `detect`, `capabilities` and `listModels`. */
function stub(opts: StubOptions = {}): AgentAdapter {
  nextId += 1;
  const id = `stub${nextId}`;
  return {
    id,
    displayName: `Stub ${nextId}`,
    capabilities: {
      resume: false,
      readOnly: true,
      structuredOutput: false,
      ...(opts.models ? { models: opts.models } : {}),
    },
    detect: (): Promise<Detection> =>
      Promise.resolve({ installed: opts.installed ?? true, minVersionOk: true }),
    run: () => {
      throw new Error('not used');
    },
    ...(opts.list ? { listModels: opts.list } : {}),
  };
}

beforeEach(() => {
  resetModelCache();
});

describe('listModels', () => {
  it('prefers what the CLI reports and says so', async () => {
    const adapter = stub({
      models: ['stale'],
      list: () => Promise.resolve([{ id: 'auto', label: 'Auto' }]),
    });
    const [catalog] = await listAllModels([adapter]);
    expect(catalog).toEqual({
      runtime: adapter.id,
      models: [{ id: 'auto', label: 'Auto' }],
      source: 'cli',
    });
  });

  it('falls back to the built-in list when the CLI call fails, and explains why', async () => {
    const adapter = stub({
      models: ['opus', 'sonnet'],
      list: () => Promise.reject(new Error('offline')),
    });
    const [catalog] = await listAllModels([adapter]);
    expect(catalog?.source).toBe('static');
    expect(catalog?.models).toEqual([{ id: 'opus' }, { id: 'sonnet' }]);
    expect(catalog?.note).toContain('offline');
  });

  it('falls back when the CLI lists nothing at all', async () => {
    const adapter = stub({ models: ['opus'], list: () => Promise.resolve([]) });
    const [catalog] = await listAllModels([adapter]);
    expect(catalog?.source).toBe('static');
    expect(catalog?.models).toEqual([{ id: 'opus' }]);
  });

  it('is static, not empty, for a runtime that cannot list its models', async () => {
    const adapter = stub({ models: ['gpt-5.2'] });
    const [catalog] = await listAllModels([adapter]);
    expect(catalog).toEqual({ runtime: adapter.id, models: [{ id: 'gpt-5.2' }], source: 'static' });
  });

  it('asks the CLI once, then serves the cache until it is reset', async () => {
    let calls = 0;
    const adapter = stub({
      list: () => {
        calls += 1;
        return Promise.resolve([{ id: 'auto' }]);
      },
    });

    await listAllModels([adapter]);
    await listAllModels([adapter]);
    expect(calls).toBe(1);

    resetModelCache();
    await listAllModels([adapter]);
    expect(calls).toBe(2);
  });

  it('skips runtimes that are not installed rather than listing them empty', async () => {
    const here = stub({ models: ['opus'] });
    const missing = stub({ installed: false, models: ['nope'] });
    const catalogs = await listAllModels([here, missing]);
    expect(catalogs.map((c) => c.runtime)).toEqual([here.id]);
  });

  it('answers for a known runtime by id, and empties for an unknown one', async () => {
    const claude = await listModels('claude');
    expect(claude.source).toBe('static');
    expect(claude.models.map((m) => m.id)).toContain('opus');

    expect(await listModels('not-a-runtime')).toEqual({
      runtime: 'not-a-runtime',
      models: [],
      source: 'static',
      note: 'unknown runtime',
    });
  });
});

describe('modelRejectionHint', () => {
  it('fires on the 404 claude actually returns for a bad model', () => {
    const hint = modelRejectionHint('opus-5', CLAUDE_404);
    expect(hint).toContain('"opus-5"');
    expect(hint).toContain('model list');
  });

  it('fires on the machine-readable spellings too', () => {
    expect(modelRejectionHint('x', 'stream error: model_not_found')).toBeDefined();
    expect(modelRejectionHint('x', '[claude-code:unrecognized_model] {"model":"x"}')).toBeDefined();
    expect(modelRejectionHint('x', 'unknown model "x"')).toBeDefined();
  });

  it('stays quiet for failures that have nothing to do with the model', () => {
    expect(modelRejectionHint('opus', 'turn stalled and was killed')).toBeUndefined();
    expect(modelRejectionHint('opus', 'codex exited with code 1')).toBeUndefined();
    expect(modelRejectionHint('opus', '')).toBeUndefined();
  });

  it('still explains itself when no model was named', () => {
    expect(modelRejectionHint(undefined, CLAUDE_404)).toContain('that model');
  });
});
