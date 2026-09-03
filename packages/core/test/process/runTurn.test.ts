import { describe, expect, it } from 'vitest';

import { runTurn } from '../../src/process/runTurn.js';
import type {
  EventSink,
  TurnEvent,
  TurnExitContext,
  TurnParser,
  TurnResult,
} from '../../src/types.js';

/**
 * These drive a tiny `node -e` child rather than a real agent CLI, so they are hermetic and
 * fast, and they can actually reproduce the failure modes that matter: a full stderr pipe,
 * a stalled turn, a cancelled turn. A test against a live CLI would only find those by luck.
 */
class CollectingParser implements TurnParser {
  lines: string[] = [];

  onLine(line: string, emit: EventSink): void {
    this.lines.push(line);
    emit({ type: 'text', text: line });
  }

  onExit(ctx: TurnExitContext, emit: EventSink): TurnResult {
    const error =
      ctx.spawnError ??
      (ctx.exitCode === 0 ? undefined : `exited with ${ctx.exitCode ?? 'signal'}`);
    if (!error) emit({ type: 'done', text: this.lines.join('\n') });
    return { ok: !error, text: this.lines.join('\n'), exitCode: ctx.exitCode, error };
  }
}

function nodeChild(script: string, opts: Partial<Parameters<typeof runTurn>[0]> = {}) {
  const events: TurnEvent[] = [];
  const parser = new CollectingParser();
  const handle = runTurn({
    argv: [process.execPath, '-e', script],
    cwd: process.cwd(),
    stdin: '',
    timeoutMs: 10_000,
    parser,
    sink: (ev) => events.push(ev),
    ...opts,
  });
  return { handle, events, parser };
}

describe('runTurn', () => {
  it('streams stdout lines and resolves on a clean exit', async () => {
    const { handle, events } = nodeChild(
      'console.log(JSON.stringify({a:1}));console.log(JSON.stringify({a:2}));',
    );
    const result = await handle.done;
    expect(result.ok).toBe(true);
    expect(result.text).toBe('{"a":1}\n{"a":2}');
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('passes the prompt in on stdin and closes it', async () => {
    const { handle } = nodeChild(
      'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log("got:"+d.trim()));',
      { stdin: 'hello from acr' },
    );
    const result = await handle.done;
    expect(result.text).toBe('got:hello from acr');
  });

  it('reports a non-zero exit as a failed turn', async () => {
    const { handle, events } = nodeChild('process.exit(7)');
    const result = await handle.done;
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('does not deadlock when the child floods stderr', async () => {
    // Regression guard: without a concurrent stderr drain this fills the OS pipe buffer
    // and both processes wait for each other forever.
    const { handle } = nodeChild(
      'const big="e".repeat(1024);for(let i=0;i<2048;i++)process.stderr.write(big);console.log("done");',
    );
    const result = await handle.done;
    expect(result.ok).toBe(true);
    expect(result.text).toBe('done');
  });

  it('kills a child that goes quiet for longer than the stall timeout', async () => {
    const { handle } = nodeChild('setTimeout(()=>{},60000)', { timeoutMs: 300 });
    const result = await handle.done;
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain('stalled');
  });

  it('keeps a chatty but slow child alive, because the stall clock resets on output', async () => {
    const { handle } = nodeChild(
      'let n=0;const t=setInterval(()=>{console.log(n);if(++n===5){clearInterval(t)}},100);',
      { timeoutMs: 600 },
    );
    const result = await handle.done;
    expect(result.ok).toBe(true);
    expect(result.text.split('\n')).toHaveLength(5);
  });

  it('leaves no live process behind when a turn is cancelled', async () => {
    const { handle } = nodeChild('setInterval(()=>{},1000)');
    handle.cancel('user interrupted');
    const result = await handle.done;
    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('explains a missing binary instead of throwing', async () => {
    const events: TurnEvent[] = [];
    const handle = runTurn({
      argv: ['acr-definitely-not-a-real-binary'],
      cwd: process.cwd(),
      stdin: '',
      timeoutMs: 1000,
      parser: new CollectingParser(),
      sink: (ev) => events.push(ev),
    });
    const result = await handle.done;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not on your PATH');
  });

  it('runs the cleanup hook exactly once, whatever happened', async () => {
    let calls = 0;
    const { handle } = nodeChild('console.log("x")', { cleanup: () => (calls += 1) });
    await handle.done;
    handle.cancel();
    expect(calls).toBe(1);
  });

  it('survives a parser that throws on a line', async () => {
    const events: TurnEvent[] = [];
    const handle = runTurn({
      argv: [process.execPath, '-e', 'console.log("boom")'],
      cwd: process.cwd(),
      stdin: '',
      timeoutMs: 5000,
      parser: {
        onLine() {
          throw new Error('parser exploded');
        },
        onExit: (ctx) => ({ ok: true, text: '', exitCode: ctx.exitCode }),
      },
      sink: (ev) => events.push(ev),
    });
    const result = await handle.done;
    expect(result.ok).toBe(true);
    expect(events.some((e) => e.type === 'error' && e.message.includes('parser exploded'))).toBe(
      true,
    );
  });
});
