import { describe, expect, it } from 'vitest';

import {
  applyCompletion,
  completions,
  mentionAtCaret,
  parseMention,
  parseRoomRefs,
  roomCompletions,
} from '../src/lib/mentions.js';

const ROSTER = ['claude', 'codex', 'cursor'];

const ROOMS = [
  { id: 'r1', slug: 'flaky-login', title: 'Fix the flaky login test' },
  { id: 'r2', slug: 'auth-spike', title: 'The auth spike' },
];

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

describe('room references', () => {
  it('picks up a #slug anywhere in the message, unlike an @mention', () => {
    // A mention routes the next turn, so it has to lead. A reference means the same thing
    // wherever it appears, so it does not.
    expect(parseRoomRefs('compare this with #flaky-login please', ROOMS)).toEqual(['r1']);
    expect(parseRoomRefs('#auth-spike and #flaky-login', ROOMS)).toEqual(['r2', 'r1']);
  });

  it('names each room once, however many times it is written', () => {
    expect(parseRoomRefs('#flaky-login vs #flaky-login', ROOMS)).toEqual(['r1']);
  });

  it('leaves a hash that names no room alone', () => {
    // `#1234` is an issue number, and `a#b` is not a reference at all.
    expect(parseRoomRefs('see #1234 and a#flaky-login', ROOMS)).toEqual([]);
    expect(parseRoomRefs('nothing here', ROOMS)).toEqual([]);
  });

  it('completes on slug or title, and drives the same machinery as @', () => {
    expect(roomCompletions('auth', ROOMS).map((r) => r.id)).toEqual(['r2']);
    expect(roomCompletions('flaky', ROOMS).map((r) => r.id)).toEqual(['r1']);
    // The title matches too, so you can find a room you named but did not slug.
    expect(roomCompletions('spike', ROOMS).map((r) => r.id)).toEqual(['r2']);
    expect(roomCompletions('', ROOMS)).toHaveLength(2);

    const value = 'look at #au for this';
    const ref = mentionAtCaret(value, 11, '#')!;
    expect(ref).toEqual({ query: 'au', at: 8 });
    expect(applyCompletion(value, ref, 'auth-spike', '#')).toEqual({
      value: 'look at #auth-spike for this',
      caret: 'look at #auth-spike '.length,
    });
  });
});
