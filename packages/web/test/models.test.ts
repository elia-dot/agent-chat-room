import type { ModelCatalog } from '@agent-chat-room/core';
import { describe, expect, it } from 'vitest';

import { byRuntime, isKnownModel, optionsFor } from '../src/lib/models.js';

const catalog: ModelCatalog = {
  runtime: 'claude',
  models: [{ id: 'opus' }, { id: 'sonnet', label: 'Sonnet 5' }],
  source: 'static',
};

describe('the options a model picker shows', () => {
  it('is just the catalog when nothing is selected', () => {
    expect(optionsFor(catalog, '')).toEqual(catalog.models);
    expect(optionsFor(catalog, undefined)).toEqual(catalog.models);
  });

  it('does not repeat a model that is already in the list', () => {
    expect(optionsFor(catalog, 'opus')).toEqual(catalog.models);
  });

  it('keeps a hand-typed model, so it survives a re-render', () => {
    // `claude-opus-5[1m]` is legal and unlistable; it must not vanish from the control.
    expect(optionsFor(catalog, 'claude-opus-5[1m]')).toEqual([
      { id: 'claude-opus-5[1m]' },
      ...catalog.models,
    ]);
  });

  it('offers the selection alone when there is no catalog at all', () => {
    expect(optionsFor(undefined, 'opus')).toEqual([{ id: 'opus' }]);
    expect(optionsFor(undefined, '')).toEqual([]);
  });
});

describe('isKnownModel', () => {
  it('matches exactly – `opus-5` is not `opus`', () => {
    expect(isKnownModel(catalog, 'opus')).toBe(true);
    expect(isKnownModel(catalog, 'opus-5')).toBe(false);
    expect(isKnownModel(catalog, 'op')).toBe(false);
  });

  it('treats "no model" as fine, because the runtime picks its own', () => {
    expect(isKnownModel(catalog, '')).toBe(true);
    expect(isKnownModel(catalog, '  ')).toBe(true);
  });

  it('does not accuse a runtime whose catalog never arrived', () => {
    expect(isKnownModel(undefined, 'anything')).toBe(false);
  });
});

describe('byRuntime', () => {
  it('indexes the route payload the way every caller reads it', () => {
    expect(byRuntime([catalog])).toEqual({ claude: catalog });
    expect(byRuntime([])).toEqual({});
  });
});
