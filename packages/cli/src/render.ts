import pc from 'picocolors';

import type {
  EngineEvent,
  Message,
  ParsedVerdict,
  Room,
  RoomMode,
  RoomOutcome,
  RoomState,
  TurnEvent,
  Usage,
} from '@agent-chat-room/core';
import { decisionLabel } from '@agent-chat-room/core';

/** Runtime brand colours from PLAN.md section 5: Claude orange, Codex green, Cursor blue. */
const RUNTIME_COLOR: Record<string, number> = {
  claude: 208,
  codex: 42,
  cursor: 39,
  echo: 245,
};

const CSI = '\u001b[';

/** What each brainstorm round is for, so the separator says more than a number. */
const BRAINSTORM_ROUND_LABEL: Record<number, string> = {
  1: 'everyone answers',
  2: 'everyone reacts',
  3: 'the moderator merges',
};

/** The status dots from PLAN.md section 5, in their terminal form. */
const STATE_DOT: Record<RoomState, string> = {
  idle: 'o',
  running: '*',
  'waiting-reviews': '*',
  approved: '+',
  'needs-you': '!',
  stopped: 'x',
};

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
  /** The round whose separator has already been printed, so it is printed once. */
  private lastRound = 0;
  /**
   * The room's mode. A brainstorm has no reviewers and no verdicts, so "no verdict block"
   * would be a complaint about a rule that does not apply to it.
   */
  private mode: RoomMode = 'build-review';

  constructor(opts: RendererOptions = {}) {
    this.color =
      opts.color ?? (process.stdout.isTTY === true && !process.env.NO_COLOR && !process.env.CI);
    this.write = opts.write ?? ((chunk) => void process.stdout.write(chunk));
  }

  /** Tell the renderer which room it is rendering. Affects round headers and verdicts. */
  setMode(mode: RoomMode): void {
    this.mode = mode;
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

  // --- engine events -------------------------------------------------------

  /**
   * Render one `EngineEvent`. This is the same stream M2's WebSocket forwards to the web
   * client, so the terminal and the browser are two views of one thing rather than two
   * implementations of the same loop.
   */
  engineEvent(ev: EngineEvent): void {
    switch (ev.type) {
      case 'room.state':
        if (ev.state === 'running' && ev.round > this.lastRound) {
          this.lastRound = ev.round;
          this.roundSeparator(ev.round);
        }
        if (ev.state === 'approved' || ev.state === 'needs-you' || ev.state === 'stopped') {
          this.info(`  state: ${ev.state}`);
        }
        return;
      case 'message.start':
        this.header(ev.author, ev.role, ev.round);
        return;
      case 'message.delta':
        if (ev.text.length === 0) return;
        this.write(ev.text);
        this.atLineStart = ev.text.endsWith('\n');
        return;
      case 'turn.activity':
        this.event(ev.event);
        return;
      case 'message.done':
        this.messageDone(ev.message);
        return;
    }
  }

  private messageDone(message: Message): void {
    if (message.kind === 'system') {
      this.ensureLineStart();
      this.line(this.dim(`  -- ${message.text.split('\n')[0] ?? ''}`));
      for (const extra of message.text.split('\n').slice(1)) {
        if (extra.trim()) this.line(this.dim(`     ${extra}`));
      }
      return;
    }
    if (message.kind === 'user') return;
    // Nobody reviews in a brainstorm, so there is no verdict to be missing.
    if (this.mode === 'brainstorm') return;
    if (message.role === 'reviewer') {
      this.verdict(
        message.verdict
          ? { ok: true, verdict: message.verdict, raw: '' }
          : { ok: false, reason: 'no verdict block in the review' },
      );
    }
  }

  private roundSeparator(round: number): void {
    const label =
      this.mode === 'brainstorm' && BRAINSTORM_ROUND_LABEL[round]
        ? `: ${BRAINSTORM_ROUND_LABEL[round]}`
        : '';
    this.line();
    this.line(this.dim(`---- round ${round}${label} ----`));
  }

  /** The closing line of a run: where the room ended up and what it produced. */
  outcome(outcome: RoomOutcome): void {
    this.line();
    const label =
      outcome.state === 'approved'
        ? this.paint(' APPROVED ', 42)
        : // A brainstorm that reached `needs-you` produced its proposal: that is the
          // finish line, not a stall, so it should not read like one.
          outcome.mode === 'brainstorm' && outcome.state === 'needs-you'
          ? this.paint(' PROPOSED ', 42)
          : this.paint(` ${outcome.state.toUpperCase()} `, 214);
    this.line(`${this.bold(label)} after ${outcome.round} round${outcome.round === 1 ? '' : 's'}`);
    if (outcome.commit) this.info(`  commit ${outcome.commit}`);
    if (outcome.changedFiles.length > 0) {
      this.info(`  changed: ${outcome.changedFiles.join(', ')}`);
    }
    if (outcome.error) this.error(`  ${outcome.error}`);
  }

  /** One line per room in `acr rooms ls`. */
  roomLine(room: Room): void {
    const dot = STATE_DOT[room.state] ?? '?';
    const id = room.id.slice(0, 8);
    this.line(
      `${dot} ${this.bold(id)}  ${room.title}  ${this.dim(
        `${room.state} · round ${room.round}/${room.maxRounds} · ${room.roomBranch}`,
      )}`,
    );
  }

  /** One message in `acr rooms show`. */
  transcriptMessage(message: Message): void {
    if (message.kind === 'system') {
      this.line(this.dim(`  -- ${message.text}`));
      return;
    }
    this.header(message.author, message.role ?? message.kind, message.round);
    this.line(message.text.trim());
    if (message.activity.length > 0) {
      this.info(`  activity: ${message.activity.length} events`);
    }
    if (message.verdict) {
      this.verdict({ ok: true, verdict: message.verdict, raw: '' });
    }
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
