import { describe, expect, it } from 'vitest';

import type { EngineEvent } from '../../src/engine/events.js';
import { TurnStream } from '../../src/engine/events.js';

/** Collect what a stream emits, so a test can assert on the deltas a client would see. */
function stream(): { turn: TurnStream; events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  return { turn: new TurnStream('r1', 't1', 'm1', (event) => events.push(event)), events };
}

const deltas = (events: EngineEvent[]): string[] =>
  events.filter((e) => e.type === 'message.delta').map((e) => e.text);

describe('TurnStream', () => {
  it('starts a new paragraph when prose resumes after a tool call', () => {
    // Runtimes emit one `text` event per content block, and a block that follows a tool
    // call is a new paragraph. Joined raw they read as one sentence: "Reading x. Reading
    // y. Now the test." – which is what the transcript used to show.
    const { turn, events } = stream();
    turn.push({ type: 'text', text: 'Reading x.' });
    turn.push({ type: 'tool', name: 'Read', summary: 'x.js' });
    turn.push({ type: 'text', text: 'Reading y.' });
    turn.push({ type: 'tool', name: 'Read', summary: 'y.js' });
    turn.push({ type: 'text', text: 'Now the test.' });

    expect(turn.text).toBe('Reading x.\n\nReading y.\n\nNow the test.');
    expect(deltas(events)).toEqual(['Reading x.', '\n\nReading y.', '\n\nNow the test.']);
  });

  it('leaves consecutive prose alone, which is a block still streaming', () => {
    const { turn, events } = stream();
    turn.push({ type: 'text', text: 'half a ' });
    turn.push({ type: 'text', text: 'sentence' });

    expect(turn.text).toBe('half a sentence');
    expect(deltas(events)).toEqual(['half a ', 'sentence']);
  });

  it('adds no break where the prose already ends the paragraph itself', () => {
    const { turn } = stream();
    turn.push({ type: 'text', text: 'a list:\n' });
    turn.push({ type: 'file', path: 'src/add.js', op: 'edit' });
    turn.push({ type: 'text', text: '- done' });

    expect(turn.text).toBe('a list:\n- done');
  });

  it('never opens a turn with a blank line, whatever arrives first', () => {
    const { turn } = stream();
    turn.push({ type: 'tool', name: 'Read', summary: 'x.js' });
    turn.push({ type: 'text', text: 'first words' });

    expect(turn.text).toBe('first words');
  });

  it('still lets the runtime replace the streamed text with its own final answer', () => {
    const { turn } = stream();
    turn.push({ type: 'text', text: 'thinking' });
    turn.push({ type: 'tool', name: 'Read', summary: 'x.js' });
    turn.push({ type: 'text', text: 'more thinking' });
    turn.push({ type: 'done', text: 'the answer' });

    expect(turn.text).toBe('the answer');
  });
});
