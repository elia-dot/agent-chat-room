import { describe, expect, it } from 'vitest';

import { applyCompletion, completions, mentionAtCaret, parseMention } from '../src/lib/mentions.js';

const ROSTER = ['claude', 'codex', 'cursor'];

describe('parseMention', () => {
  it('routes the next turn to a leading mention and preserves it in the transcript text', () => {
    expect(parseMention('@codex what do you make of this?', ROSTER)).toEqual({
      mention: 'codex',
      text: '@codex what do you make of this?',
    });
    expect(parseMention('  @claude  fix it  ', ROSTER)).toEqual({
      mention: 'claude',
      text: '@claude  fix it',
    });
    // A mention on its own is a visible "your turn" message.
    expect(parseMention('@codex', ROSTER)).toEqual({ mention: 'codex', text: '@codex' });
  });

  it('matches a name case-insensitively but keeps the roster spelling', () => {
    expect(parseMention('@Codex look again', ROSTER).mention).toBe('codex');
  });

  it('leaves a mention that is not at the start alone', () => {
    // "ask @codex about this" is a sentence about codex, not an instruction to hand it the
    // next turn. Rerouting on it would be the kind of surprise that stops people typing names.
    expect(parseMention('ask @codex about this', ROSTER)).toEqual({
      mention: null,
      text: 'ask @codex about this',
    });
  });

  it('keeps an unknown name in the text rather than silently dropping it', () => {
    expect(parseMention('@gemini hello', ROSTER)).toEqual({
      mention: null,
      text: '@gemini hello',
    });
  });

  it('handles a message with no mention at all', () => {
    expect(parseMention('just a message', ROSTER)).toEqual({
      mention: null,
      text: 'just a message',
    });
    expect(parseMention('', ROSTER)).toEqual({ mention: null, text: '' });
    expect(parseMention('email me at foo@bar.com', ROSTER).mention).toBeNull();
  });
});

describe('mention autocomplete', () => {
  it('finds the mention the caret is inside, and nothing else', () => {
    expect(mentionAtCaret('@cod', 4)).toEqual({ query: 'cod', at: 0 });
    expect(mentionAtCaret('hey @cu', 7)).toEqual({ query: 'cu', at: 4 });
    // Past the end of the word there is nothing left to complete.
    expect(mentionAtCaret('@codex and then', 15)).toBeNull();
    // `foo@bar` is an email address.
    expect(mentionAtCaret('foo@bar', 7)).toBeNull();
    expect(mentionAtCaret('nothing here', 5)).toBeNull();
  });

  it('offers the roster in order and completes with a trailing space', () => {
    expect(completions('c', ROSTER)).toEqual(ROSTER);
    expect(completions('cu', ROSTER)).toEqual(['cursor']);
    expect(completions('z', ROSTER)).toEqual([]);

    const value = 'hey @cu how are you';
    const mention = mentionAtCaret(value, 7)!;
    expect(applyCompletion(value, mention, 'cursor')).toEqual({
      value: 'hey @cursor how are you',
      caret: 'hey @cursor '.length,
    });
  });
});
