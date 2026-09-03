import { join } from 'node:path';

import { credentialPresent, home, meetsMinVersion, readVersion, which } from '../detect.js';
import { claudePermissionArgs } from '../permissions.js';
import { parseJsonLine } from '../process/lines.js';
import { runTurn } from '../process/runTurn.js';
import type {
  AgentAdapter,
  Detection,
  EventSink,
  TurnEvent,
  TurnExitContext,
  TurnHandle,
  TurnParser,
  TurnRequest,
  TurnResult,
  Usage,
} from '../types.js';

export const CLAUDE_BIN = 'claude';
export const CLAUDE_MIN_VERSION = '2.0.0';

/** Tools whose use means a file on disk changed. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

export function buildClaudeArgs(req: TurnRequest): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    // The user's own global hooks and settings fire inside a headless run too, which has
    // been observed injecting `system/hook_*` events into the stream. Loading project
    // settings only keeps a personal SessionStart hook out of a room's turn.
    '--setting-sources',
    'project',
    ...claudePermissionArgs(req.permission),
  ];
  if (req.model) args.push('--model', req.model);
  if (req.systemAppend) args.push('--append-system-prompt', req.systemAppend);
  if (req.sessionId) args.push('--resume', req.sessionId);
  if (req.outputSchema) args.push('--json-schema', JSON.stringify(req.outputSchema));
  return args;
}

/**
 * Parser for `claude -p --output-format stream-json`.
 *
 * Shapes confirmed against claude 2.1.259: `system/init` carries `session_id`, `assistant`
 * carries Anthropic content blocks, `user` carries tool results, `result` carries the final
 * text and usage. Anything else – `rate_limit_event`, `system/hook_started`, whatever the
 * next release adds – is ignored rather than treated as a failure. An adapter that throws
 * on an unknown event type is an adapter that breaks on every CLI upgrade.
 */
export class ClaudeParser implements TurnParser {
  private sessionId: string | undefined;
  private finalText = '';
  private streamedText = '';
  private structured: unknown;
  private usage: Usage | undefined;
  private errorMessage: string | undefined;
  private readonly toolNames = new Map<string, string>();

  onLine(line: string, emit: EventSink): void {
    const ev = parseJsonLine(line);
    if (!ev) return;
    const type = typeof ev.type === 'string' ? ev.type : '';

    switch (type) {
      case 'system':
        this.onSystem(ev, emit);
        return;
      case 'assistant':
        this.onAssistant(ev, emit);
        return;
      case 'user':
        this.onUser(ev, emit);
        return;
      case 'result':
        this.onResult(ev, emit);
        return;
      default:
        // Unknown top-level event (e.g. `rate_limit_event`). Recorded in the turn log, not
        // surfaced and never fatal.
        this.captureSessionId(ev, emit);
    }
  }

  private captureSessionId(ev: Record<string, unknown>, emit: EventSink): void {
    if (this.sessionId) return;
    const id = ev.session_id;
    if (typeof id === 'string' && id.length > 0) {
      this.sessionId = id;
      emit({ type: 'started', sessionId: id });
    }
  }

  private onSystem(ev: Record<string, unknown>, emit: EventSink): void {
    // `init` is the one subtype we care about; `hook_started`, `hook_response` and friends
    // come from the user's own configuration and are none of our business.
    this.captureSessionId(ev, emit);
  }

  private onAssistant(ev: Record<string, unknown>, emit: EventSink): void {
    this.captureSessionId(ev, emit);
    for (const block of contentBlocks(ev.message)) {
      const kind = block.type;
      if (kind === 'text' && typeof block.text === 'string') {
        this.streamedText += block.text;
        emit({ type: 'text', text: block.text });
      } else if (kind === 'tool_use') {
        const name = typeof block.name === 'string' ? block.name : 'tool';
        const id = typeof block.id === 'string' ? block.id : undefined;
        if (id) this.toolNames.set(id, name);
        const input = isRecord(block.input) ? block.input : {};
        emit({ type: 'tool', name, summary: summariseToolInput(name, input) });
        const path = filePathFrom(input);
        if (WRITE_TOOLS.has(name) && path) {
          emit({ type: 'file', path, op: fileOpFor(name, input) });
        }
      }
    }
  }

  private onUser(ev: Record<string, unknown>, emit: EventSink): void {
    for (const block of contentBlocks(ev.message)) {
      if (block.type !== 'tool_result') continue;
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
      const name = (id && this.toolNames.get(id)) || 'tool';
      emit({ type: 'tool', name, summary: `→ ${summariseToolResult(block)}` });
    }
  }

  private onResult(ev: Record<string, unknown>, emit: EventSink): void {
    this.captureSessionId(ev, emit);
    if (typeof ev.result === 'string') this.finalText = ev.result;
    if (isRecord(ev.usage)) this.usage = normaliseUsage(ev.usage);
    if (ev.structured_result !== undefined) this.structured = ev.structured_result;

    if (ev.is_error === true || ev.subtype === 'error_during_execution') {
      this.errorMessage =
        typeof ev.result === 'string' && ev.result.length > 0
          ? ev.result
          : `claude reported an error (${typeof ev.subtype === 'string' ? ev.subtype : 'unknown'})`;
      return;
    }
    // No event emitted here: the final text reaches the sink as the `done` event once the
    // child has actually exited, which is the only point at which a turn is really over.
  }

  private text(): string {
    return this.finalText || this.streamedText;
  }

  onExit(ctx: TurnExitContext, emit: EventSink): TurnResult {
    const base = {
      text: this.text(),
      sessionId: this.sessionId,
      usage: this.usage,
      structured: this.structured,
      exitCode: ctx.exitCode,
    };

    const failure = failureReason(ctx, this.errorMessage, 'claude');
    if (failure) return { ...base, ok: false, error: failure };

    const done: TurnEvent = {
      type: 'done',
      text: base.text,
      usage: this.usage,
      structured: this.structured,
    };
    emit(done);
    return { ...base, ok: true };
  }
}

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  capabilities: { resume: true, readOnly: true, structuredOutput: true },

  async detect(): Promise<Detection> {
    const binPath = which(CLAUDE_BIN);
    if (!binPath) {
      return {
        installed: false,
        minVersionOk: false,
        note: `\`${CLAUDE_BIN}\` is not on your PATH`,
      };
    }
    const version = await readVersion(binPath);
    return {
      installed: true,
      binPath,
      version,
      minVersionOk: meetsMinVersion(version, CLAUDE_MIN_VERSION),
      // Presence only: we check that a credentials file exists, never what is in it.
      loggedIn: credentialPresent([
        join(home(), '.claude', '.credentials.json'),
        join(home(), '.claude.json'),
      ]),
      note:
        version && !meetsMinVersion(version, CLAUDE_MIN_VERSION)
          ? `needs >= ${CLAUDE_MIN_VERSION}`
          : undefined,
    };
  },

  run(req: TurnRequest, sink: EventSink): TurnHandle {
    return runTurn({
      argv: [CLAUDE_BIN, ...buildClaudeArgs(req)],
      cwd: req.cwd,
      stdin: req.prompt,
      timeoutMs: req.timeoutMs,
      parser: new ClaudeParser(),
      sink,
      turnId: req.turnId,
    });
  },
};

// --- helpers ---------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function contentBlocks(message: unknown): Record<string, unknown>[] {
  if (!isRecord(message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

function filePathFrom(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const v = input[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function fileOpFor(name: string, input: Record<string, unknown>): 'edit' | 'create' | 'delete' {
  if (name === 'Write' && input.old_string === undefined) return 'create';
  return 'edit';
}

function summariseToolInput(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash' && typeof input.command === 'string') return truncate(input.command, 160);
  const path = filePathFrom(input);
  if (path) return path;
  if (typeof input.pattern === 'string') return input.pattern;
  const keys = Object.keys(input);
  return keys.length > 0 ? truncate(JSON.stringify(input), 160) : '';
}

function summariseToolResult(block: Record<string, unknown>): string {
  const content = block.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter(isRecord)
            .map((c) => (typeof c.text === 'string' ? c.text : ''))
            .join(' ')
        : '';
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  const prefix = block.is_error === true ? 'error: ' : '';
  return truncate(prefix + firstLine.trim(), 160) || (block.is_error === true ? 'error' : 'ok');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function normaliseUsage(usage: Record<string, unknown>): Usage {
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cached = num(usage.cache_read_input_tokens);
  const total =
    input === undefined && output === undefined ? undefined : (input ?? 0) + (output ?? 0);
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    totalTokens: total,
  };
}

/** Shared exit classification, so both adapters explain a dead turn the same way. */
export function failureReason(
  ctx: TurnExitContext,
  reported: string | undefined,
  bin: string,
): string | undefined {
  if (ctx.spawnError) return ctx.spawnError;
  if (reported) return reported;
  if (ctx.cancelled) return 'turn cancelled';
  if (ctx.timedOut) return 'turn stalled and was killed';
  if (ctx.exitCode !== 0 && ctx.exitCode !== null) {
    const tail = ctx.stderr.trim().split('\n').slice(-5).join('\n');
    return `${bin} exited with code ${ctx.exitCode}${tail ? `:\n${tail}` : ''}`;
  }
  if (ctx.exitCode === null && ctx.signal) return `${bin} was killed by ${ctx.signal}`;
  return undefined;
}
