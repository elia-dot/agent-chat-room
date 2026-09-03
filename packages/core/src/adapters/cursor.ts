import { join } from 'node:path';

import { credentialPresent, home, meetsMinVersion, readVersion, which } from '../detect.js';
import { cursorPermissionArgs } from '../permissions.js';
import { parseJsonLine } from '../process/lines.js';
import { runTurn } from '../process/runTurn.js';
import type {
  AgentAdapter,
  Detection,
  EventSink,
  TurnExitContext,
  TurnHandle,
  TurnParser,
  TurnRequest,
  TurnResult,
  Usage,
} from '../types.js';
import { failureReason } from './claude.js';

export const CURSOR_BIN = 'cursor-agent';
/** Cursor versions are dates. `compareVersions` reads `2026.07.23` numerically, so this works. */
export const CURSOR_MIN_VERSION = '2026.7.0';

/**
 * Tool calls that mean a file on disk changed. Cursor names its calls `<name>ToolCall`, so
 * these are the normalised names `toolName()` produces.
 */
const WRITE_TOOLS = new Set([
  'write',
  'edit',
  'multiedit',
  'searchreplace',
  'create',
  'createfile',
  'delete',
  'deletefile',
  'applypatch',
]);

export function buildCursorArgs(req: TurnRequest): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output'];
  args.push(...cursorPermissionArgs(req.permission));
  // The spawn already sets the working directory; naming it as the workspace as well is
  // what PLAN.md section 4.1 documents and it removes any doubt about which repo a turn
  // is looking at when `acr run` was pointed at a subdirectory.
  args.push('--workspace', req.cwd);
  if (req.model) args.push('--model', req.model);
  if (req.sessionId) args.push('--resume', req.sessionId);
  // No `--output-schema` equivalent: `capabilities.structuredOutput` is false and the
  // fenced verdict block carries the decision, which `verdict.ts` says is the real contract.
  return args;
}

/**
 * Cursor has no system-prompt flag, exactly like Codex, so role instructions are prepended
 * to the first turn's prompt. On a resumed turn the session already carries them.
 */
export function buildCursorPrompt(req: TurnRequest): string {
  if (!req.systemAppend || req.sessionId) return req.prompt;
  return `${req.systemAppend.trim()}\n\n---\n\n${req.prompt}`;
}

/**
 * Parser for `cursor-agent -p --output-format stream-json --stream-partial-output`.
 *
 * Shapes probed live against cursor-agent 2026.07.23 and recorded in
 * `test/fixtures/cursor_run.jsonl`: `system/init` carries `session_id`, `assistant` carries
 * one Anthropic-style text block per delta, `tool_call` comes in `started` / `completed`
 * pairs whose payload is keyed by tool (`readToolCall`, `shellToolCall`, …), and `result`
 * carries the final text and usage. `thinking` and the echoed `user` event are dropped, and
 * anything else is ignored rather than treated as a failure.
 */
export class CursorParser implements TurnParser {
  private sessionId: string | undefined;
  private finalText = '';
  private streamedText = '';
  private usage: Usage | undefined;
  private errorMessage: string | undefined;
  private sawResult = false;

  onLine(line: string, emit: EventSink): void {
    const ev = parseJsonLine(line);
    if (!ev) return;
    const type = typeof ev.type === 'string' ? ev.type : '';

    switch (type) {
      case 'system':
        this.captureSessionId(ev, emit);
        return;
      case 'assistant':
        this.captureSessionId(ev, emit);
        this.onAssistant(ev, emit);
        return;
      case 'tool_call':
        this.captureSessionId(ev, emit);
        this.onToolCall(ev, emit);
        return;
      case 'result':
        this.captureSessionId(ev, emit);
        this.onResult(ev);
        return;
      case 'thinking':
      case 'user':
        // Reasoning is long and is not the message; `user` is our own prompt echoed back.
        return;
      default:
        // Unknown top-level event. Recorded in the turn log, never fatal – an adapter that
        // throws on one breaks every room on the next CLI upgrade.
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

  private onAssistant(ev: Record<string, unknown>, emit: EventSink): void {
    for (const block of contentBlocks(ev.message)) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      if (block.text.length === 0) continue;
      this.streamedText += block.text;
      emit({ type: 'text', text: block.text });
    }
  }

  private onToolCall(ev: Record<string, unknown>, emit: EventSink): void {
    const call = isRecord(ev.tool_call) ? ev.tool_call : undefined;
    if (!call) return;
    const entry = toolEntry(call);
    if (!entry) return;
    const { name, payload } = entry;
    const args = isRecord(payload.args) ? payload.args : {};
    const completed = ev.subtype === 'completed';

    if (!completed) {
      emit({ type: 'tool', name, summary: summariseToolArgs(name, args) });
      return;
    }

    const outcome = resultOutcome(payload.result);
    emit({ type: 'tool', name, summary: `→ ${outcome.summary}` });

    const path = filePathFrom(args);
    if (outcome.ok && path && WRITE_TOOLS.has(name)) {
      emit({ type: 'file', path, op: fileOpFor(name) });
    }
  }

  private onResult(ev: Record<string, unknown>): void {
    this.sawResult = true;
    if (typeof ev.result === 'string') this.finalText = ev.result;
    if (isRecord(ev.usage)) this.usage = normaliseUsage(ev.usage);

    if (ev.is_error === true || ev.subtype === 'error') {
      this.errorMessage =
        typeof ev.result === 'string' && ev.result.length > 0
          ? ev.result
          : `cursor-agent reported an error (${typeof ev.subtype === 'string' ? ev.subtype : 'unknown'})`;
    }
  }

  onExit(ctx: TurnExitContext, emit: EventSink): TurnResult {
    const base = {
      text: this.finalText || this.streamedText,
      sessionId: this.sessionId,
      usage: this.usage,
      exitCode: ctx.exitCode,
    };

    const failure = failureReason(ctx, this.errorMessage, CURSOR_BIN);
    if (failure) return { ...base, ok: false, error: failure };
    if (!this.sawResult && base.text.length === 0) {
      return { ...base, ok: false, error: 'cursor-agent produced no message' };
    }

    emit({ type: 'done', text: base.text, usage: this.usage });
    return { ...base, ok: true };
  }
}

export const cursorAdapter: AgentAdapter = {
  id: 'cursor',
  displayName: 'Cursor Agent',
  // No `--output-schema` equivalent, and none is needed: the fenced verdict block is the
  // portable contract and the schema flags are the optional extra (see `verdict.ts`).
  capabilities: { resume: true, readOnly: true, structuredOutput: false },

  async detect(): Promise<Detection> {
    const binPath = which(CURSOR_BIN);
    if (!binPath) {
      return {
        installed: false,
        minVersionOk: false,
        note: `\`${CURSOR_BIN}\` is not on your PATH`,
      };
    }
    const version = await readVersion(binPath, ['--version']);
    return {
      installed: true,
      binPath,
      version,
      minVersionOk: meetsMinVersion(version, CURSOR_MIN_VERSION),
      // Presence only, like every other adapter: `cli-config.json` is where `cursor-agent
      // login` puts its auth info, and we check that it is there without opening it.
      loggedIn: credentialPresent([join(home(), '.cursor', 'cli-config.json')]),
      note:
        version && !meetsMinVersion(version, CURSOR_MIN_VERSION)
          ? `needs >= ${CURSOR_MIN_VERSION}`
          : undefined,
    };
  },

  run(req: TurnRequest, sink: EventSink): TurnHandle {
    return runTurn({
      argv: [CURSOR_BIN, ...buildCursorArgs(req)],
      cwd: req.cwd,
      // `cursor-agent -p` takes the prompt as a trailing positional argument *or* on stdin.
      // Probed: with no positional it reads stdin and answers normally. Stdin is what this
      // adapter uses, for the reason PLAN.md section 9 gives – room transcripts can exceed
      // a comfortable argv size, and macOS `ARG_MAX` is about a megabyte.
      stdin: buildCursorPrompt(req),
      timeoutMs: req.timeoutMs,
      parser: new CursorParser(),
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

/**
 * Cursor keys a tool call by its own name: `{ readToolCall: { args, result } }`. Reading the
 * key rather than a fixed list is what keeps a tool Cursor adds next month from arriving as
 * an unnamed blob.
 */
function toolEntry(
  call: Record<string, unknown>,
): { name: string; payload: Record<string, unknown> } | undefined {
  for (const [key, value] of Object.entries(call)) {
    if (!key.endsWith('ToolCall') || !isRecord(value)) continue;
    return { name: toolName(key), payload: value };
  }
  return undefined;
}

function toolName(key: string): string {
  return key.slice(0, -'ToolCall'.length).toLowerCase();
}

interface ToolOutcome {
  ok: boolean;
  summary: string;
}

/**
 * A completed call carries a one-key result envelope: `{ success: … }` when it worked, and
 * something naming the problem (`permissionDenied`, `error`) when it did not.
 */
function resultOutcome(result: unknown): ToolOutcome {
  if (!isRecord(result)) return { ok: true, summary: 'ok' };
  const [key, value] = Object.entries(result)[0] ?? [];
  if (key === undefined) return { ok: true, summary: 'ok' };
  if (key === 'success') return { ok: true, summary: 'ok' };
  const detail = isRecord(value) && typeof value.error === 'string' ? value.error : '';
  return { ok: false, summary: truncate(detail ? `${key}: ${detail}` : key, 160) };
}

function filePathFrom(args: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'file_path', 'filePath', 'targetFile', 'target_file']) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function fileOpFor(name: string): 'edit' | 'create' | 'delete' {
  if (name.includes('delete')) return 'delete';
  if (name === 'create' || name === 'createfile') return 'create';
  return 'edit';
}

function summariseToolArgs(name: string, args: Record<string, unknown>): string {
  if (name === 'shell' && typeof args.command === 'string') return truncate(args.command, 160);
  const path = filePathFrom(args);
  if (path) return path;
  for (const key of ['globPattern', 'query', 'pattern']) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) return truncate(v, 160);
  }
  return '';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** Cursor reports camelCase token counts, unlike Claude's and Codex's snake_case. */
function normaliseUsage(usage: Record<string, unknown>): Usage {
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  const cached = num(usage.cacheReadTokens);
  const total =
    input === undefined && output === undefined ? undefined : (input ?? 0) + (output ?? 0);
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    totalTokens: total,
  };
}
