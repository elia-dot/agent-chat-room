import pc from 'picocolors';

import type { ParsedVerdict, TurnEvent, Usage } from '@agent-chat-room/core';
import { decisionLabel } from '@agent-chat-room/core';

/** Runtime brand colours from PLAN.md section 5: Claude orange, Codex green, Cursor blue. */
const RUNTIME_COLOR: Record<string, number> = {
  claude: 208,
  codex: 42,
  cursor: 39,
  echo: 245,
};

const CSI = '\u001b[';

export interface RendererOptions {
  color?: boolean;
  /** Where to write. Injectable so tests can capture output. */
  write?: (chunk: string) => void;
}

/**
 * Terminal renderer for a turn's event stream.
 *
 * It degrades to plain text when stdout is not a TTY or `NO_COLOR` is set, because `acr run`
 * is meant to be pipeable into a file or a CI log.
 */
export class Renderer {
  private readonly color: boolean;
  private readonly write: (chunk: string) => void;
  private atLineStart = true;

  constructor(opts: RendererOptions = {}) {
    this.color =
      opts.color ?? (process.stdout.isTTY === true && !process.env.NO_COLOR && !process.env.CI);
    this.write = opts.write ?? ((chunk) => void process.stdout.write(chunk));
  }

  /** 256-colour paint, which picocolors does not offer and the runtime palette needs. */
  private paint(text: string, code: number): string {
    return this.color ? `${CSI}38;5;${code}m${text}${CSI}39m` : text;
  }

  private dim(text: string): string {
    return this.color ? pc.dim(text) : text;
  }

  private bold(text: string): string {
    return this.color ? pc.bold(text) : text;
  }

  line(text = ''): void {
    this.ensureLineStart();
    this.write(`${text}\n`);
  }

  private ensureLineStart(): void {
    if (!this.atLineStart) {
      this.write('\n');
      this.atLineStart = true;
    }
  }

  /** The `[claude · worker · r1]` author header above a message. */
  header(runtime: string, role: string, round: number): void {
    const code = RUNTIME_COLOR[runtime] ?? 245;
    this.line();
    this.line(this.bold(this.paint(`[${runtime} · ${role} · r${round}]`, code)));
  }

  /** Feed one adapter event to the terminal. */
  event(ev: TurnEvent): void {
    switch (ev.type) {
      case 'started':
        this.line(this.dim(`  session ${ev.sessionId}`));
        return;
      case 'text':
        if (ev.text.length === 0) return;
        this.write(ev.text);
        this.atLineStart = ev.text.endsWith('\n');
        return;
      case 'tool':
        this.line(this.dim(`  · ${ev.name}${ev.summary ? ` ${ev.summary}` : ''}`));
        return;
      case 'file':
        this.line(this.dim(`  · ${ev.op} ${ev.path}`));
        return;
      case 'done': {
        this.ensureLineStart();
        const usage = ev.usage ? formatUsage(ev.usage) : '';
        if (usage) this.line(this.dim(`  ${usage}`));
        return;
      }
      case 'error':
        this.ensureLineStart();
        this.line(this.color ? pc.red(`  x ${ev.message}`) : `  x ${ev.message}`);
        return;
    }
  }

  /** The verdict pill printed after a reviewer turn. */
  verdict(parsed: ParsedVerdict): void {
    this.line();
    if (!parsed.ok) {
      const text = `  ! no verdict: ${parsed.reason}`;
      this.line(this.color ? pc.yellow(text) : text);
      return;
    }
    const label = decisionLabel(parsed.verdict.decision);
    const painted =
      parsed.verdict.decision === 'approve'
        ? this.paint(` ${label} `, 42)
        : this.paint(` ${label} `, 214);
    this.line(this.bold(painted));
    for (const item of parsed.verdict.blocking) this.line(`  blocking: ${item}`);
    for (const item of parsed.verdict.nits) this.line(this.dim(`  nit: ${item}`));
  }

  info(text: string): void {
    this.line(this.dim(text));
  }

  error(text: string): void {
    this.ensureLineStart();
    this.line(this.color ? pc.red(text) : text);
  }
}

export function formatUsage(usage: Usage): string {
  const bits: string[] = [];
  if (usage.inputTokens !== undefined) bits.push(`in ${usage.inputTokens}`);
  if (usage.cachedInputTokens) bits.push(`cached ${usage.cachedInputTokens}`);
  if (usage.outputTokens !== undefined) bits.push(`out ${usage.outputTokens}`);
  return bits.length > 0 ? `tokens: ${bits.join(' · ')}` : '';
}
