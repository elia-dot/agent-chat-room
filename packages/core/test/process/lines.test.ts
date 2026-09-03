import { describe, expect, it } from 'vitest';

import { LineSplitter, parseJsonLine } from '../../src/process/lines.js';

describe('LineSplitter', () => {
  it('reassembles a JSON object split across chunks', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":')).toEqual([]);
    expect(s.push('1}\n')).toEqual(['{"a":1}']);
  });

  it('returns several lines from one chunk', () => {
    const s = new LineSplitter();
    expect(s.push('a\nb\nc\n')).toEqual(['a', 'b', 'c']);
  });

  it('strips carriage returns so Windows output parses', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  it('flushes a trailing line with no newline', () => {
    const s = new LineSplitter();
    expect(s.push('tail')).toEqual([]);
    expect(s.flush()).toEqual(['tail']);
    expect(s.flush()).toEqual([]);
  });

  it('drops a single line that grows past the cap instead of buffering forever', () => {
    const s = new LineSplitter(16);
    expect(s.push('x'.repeat(64))).toEqual([]);
    expect(s.push('more')).toEqual([]);
    expect(s.push('\nnext\n')).toEqual(['next']);
    expect(s.droppedLines).toBe(1);
  });
});

describe('parseJsonLine', () => {
  it('parses an object', () => {
    expect(parseJsonLine('{"type":"x"}')).toEqual({ type: 'x' });
  });

  it('returns undefined for log noise rather than throwing', () => {
    expect(parseJsonLine('npm WARN deprecated')).toBeUndefined();
    expect(parseJsonLine('{not json}')).toBeUndefined();
    expect(parseJsonLine('[1,2]')).toBeUndefined();
    expect(parseJsonLine('null')).toBeUndefined();
    expect(parseJsonLine('')).toBeUndefined();
  });
});
