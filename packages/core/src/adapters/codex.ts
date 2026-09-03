import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { credentialPresent, home, meetsMinVersion, readVersion, which } from '../detect.js';
import { codexPermissionArgs } from '../permissions.js';
import { parseJsonLine } from '../process/lines.js';
import { runTurn } from '../process/runTurn.js';
import type {
  AgentAdapter,
  Detection,
  EventSink,
  Permission,
  TurnExitContext,
  TurnHandle,
  TurnParser,
  TurnRequest,
  TurnResult,
  Usage,
} from '../types.js';
import { failureReason } from './claude.js';

export const CODEX_BIN = 'codex';
export const CODEX_MIN_VERSION = '0.150.0';

/**
 * Codex reports some non-fatal conditions as `error` items in the middle of a turn –
 * a retry, a provider fallback, a dropped connection. Treating those as turn failures
 * ends perfectly good rounds early, so they are downgraded to activity and only
 * `turn.failed` (or a non-zero exit) actually fails a turn.
 */
const TRANSIENT_ERROR_RE =
  /\b(retry|retrying|reconnect|reconnecting|fall(?:ing)?\s*back|fallback|rate.?limit|timed?.?out, retrying)\b/i;

export interface CodexArgsOptions {
  /** Set when `req.outputSchema` has been written to a file for `--output-schema`. */
  schemaPath?: string;
}

export function buildCodexArgs(req: TurnRequest, opts: CodexArgsOptions = {}): string[] {
  // `codex exec resume` is a different subcommand with a smaller flag set: it accepts
  // neither `-C` nor `-s`. The working directory comes from the spawn instead, and the
  // sandbox has to be set through the config override that `-s` is sugar for.
  const resuming = Boolean(req.sessionId);
  const args = resuming ? ['exec', 'resume', req.sessionId!, '-'] : ['exec'];

  args.push('--json');
  if (!resuming) args.push('-C', req.cwd);
  args.push(
    ...(resuming ? codexResumeSandboxArgs(req.permission) : codexPermissionArgs(req.permission)),
  );
  args.push(
    // `acr run` may target a subdirectory, and the engine already knows the repo root, so
    // codex does not need to do its own git check.
    '--skip-git-repo-check',
    // Keeps the user's ~/.codex/config.toml (custom instructions, MCP servers, hooks) out
    // of a room's turn. Auth still comes from CODEX_HOME, which is the whole point.
    '--ignore-user-config',
  );
  if (req.model) args.push('-m', req.model);
  if (opts.schemaPath) args.push('--output-schema', opts.schemaPath);
  return args;
}

function codexResumeSandboxArgs(permission: Permission): string[] {
  if (permission === 'full') return ['--dangerously-bypass-approvals-and-sandbox'];
  const mode = permission === 'read-only' ? 'read-only' : 'workspace-write';
  return ['-c', `sandbox_mode="${mode}"`];
}

/**
 * Codex has no system-prompt flag, so role instructions are prepended to the first turn's
 * prompt. On resumed turns the session already carries them.
 */
export function buildCodexPrompt(req: TurnRequest): string {
  if (!req.systemAppend || req.sessionId) return req.prompt;
  return `${req.systemAppend.trim()}\n\n---\n\n${req.prompt}`;
}

/**
 * Parser for `codex exec --json`.
 *
 * Shapes confirmed against codex-cli 0.152.1: `thread.started` carries `thread_id`,
 * `item.completed` carries the interesting payloads, `turn.completed` carries usage but
 * *not* the final text – the final text is the last `agent_message` item, which is why we
 * track it as we go.
 */
export class CodexParser implements TurnParser {
  private threadId: string | undefined;
  private lastMessage = '';
  private usage: Usage | undefined;
  private failure: string | undefined;
  private sawTurnCompleted = false;

  onLine(line: string, emit: EventSink): void {
    const ev = parseJsonLine(line);
    if (!ev) return;
    const type = typeof ev.type === 'string' ? ev.type : '';

    switch (type) {
      case 'thread.started': {
        const id = ev.thread_id;
        if (typeof id === 'string' && id.length > 0) {
          this.threadId = id;
          emit({ type: 'started', sessionId: id });
        }
        return;
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        this.onItem(type, ev.item, emit);
        return;
      case 'turn.completed':
        this.sawTurnCompleted = true;
        if (isRecord(ev.usage)) this.usage = normaliseUsage(ev.usage);
        return;
      case 'turn.failed':
        this.failure = messageOf(ev.error) ?? 'codex reported turn.failed';
        return;
      case 'error': {
        const message = messageOf(ev) ?? 'codex reported an error';
        if (TRANSIENT_ERROR_RE.test(message)) {
          emit({ type: 'tool', name: 'codex', summary: truncate(message, 200) });
        } else {
          this.failure ??= message;
        }
        return;
      }
      default:
        // `turn.started` and anything a future release adds: ignored on purpose.
        return;
    }
  }

  private onItem(eventType: string, item: unknown, emit: EventSink): void {
    if (!isRecord(item)) return;
    const itemType = typeof item.type === 'string' ? item.type : '';
    const completed = eventType === 'item.completed';

    switch (itemType) {
      case 'agent_message': {
        if (!completed) return;
        const text = typeof item.text === 'string' ? item.text : '';
        if (text.length === 0) return;
        this.lastMessage = text;
        emit({ type: 'text', text });
        return;
      }
      case 'command_execution': {
        if (!completed) return;
        const command = typeof item.command === 'string' ? item.command : '';
        const exit = typeof item.exit_code === 'number' ? ` (exit ${item.exit_code})` : '';
        emit({ type: 'tool', name: 'bash', summary: `${truncate(command, 160)}${exit}` });
        return;
      }
      case 'file_change': {
        if (!completed) return;
        for (const change of fileChanges(item)) emit(change);
        return;
      }
      case 'error': {
        const message = messageOf(item) ?? 'codex item error';
        // A warning item is not a failed turn. Only `turn.failed` is.
        if (TRANSIENT_ERROR_RE.test(message)) {
          emit({ type: 'tool', name: 'codex', summary: truncate(message, 200) });
        } else if (completed) {
          emit({ type: 'tool', name: 'codex', summary: `warning: ${truncate(message, 200)}` });
        }
        return;
      }
      case 'reasoning':
      default:
        // Reasoning is dropped in M0: it is long, it is not the message, and the room
        // transcript is meant to read like a conversation.
        return;
    }
  }

  onExit(ctx: TurnExitContext, emit: EventSink): TurnResult {
    const base = {
      text: this.lastMessage,
      sessionId: this.threadId,
      usage: this.usage,
      exitCode: ctx.exitCode,
    };

    const failure = failureReason(ctx, this.failure, 'codex');
    if (failure) return { ...base, ok: false, error: failure };
    if (!this.sawTurnCompleted && this.lastMessage.length === 0) {
      return { ...base, ok: false, error: 'codex produced no message' };
    }

    emit({ type: 'done', text: base.text, usage: this.usage });
    return { ...base, ok: true };
  }
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  capabilities: { resume: true, readOnly: true, structuredOutput: true },

  async detect(): Promise<Detection> {
    const binPath = which(CODEX_BIN);
    if (!binPath) {
      return {
        installed: false,
        minVersionOk: false,
        note: `\`${CODEX_BIN}\` is not on your PATH`,
      };
    }
    const version = await readVersion(binPath);
    const codexHome = process.env.CODEX_HOME ?? join(home(), '.codex');
    return {
      installed: true,
      binPath,
      version,
      minVersionOk: meetsMinVersion(version, CODEX_MIN_VERSION),
      loggedIn: credentialPresent([join(codexHome, 'auth.json')]),
      note:
        version && !meetsMinVersion(version, CODEX_MIN_VERSION)
          ? `needs >= ${CODEX_MIN_VERSION}`
          : undefined,
    };
  },

  run(req: TurnRequest, sink: EventSink): TurnHandle {
    let schemaDir: string | undefined;
    let schemaPath: string | undefined;
    if (req.outputSchema) {
      // `--output-schema` takes a file, not inline JSON, so the schema gets a temp file
      // that is removed as soon as the child exits.
      schemaDir = mkdtempSync(join(tmpdir(), 'acr-schema-'));
      schemaPath = join(schemaDir, 'schema.json');
      writeFileSync(schemaPath, JSON.stringify(req.outputSchema));
    }

    return runTurn({
      argv: [CODEX_BIN, ...buildCodexArgs(req, { schemaPath })],
      cwd: req.cwd,
      stdin: buildCodexPrompt(req),
      timeoutMs: req.timeoutMs,
      parser: new CodexParser(),
      sink,
      turnId: req.turnId,
      cleanup: () => {
        if (schemaDir) rmSync(schemaDir, { recursive: true, force: true });
      },
    });
  },
};

// --- helpers ---------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function messageOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (!isRecord(v)) return undefined;
  const m = v.message;
  return typeof m === 'string' && m.length > 0 ? m : undefined;
}

function fileChanges(
  item: Record<string, unknown>,
): { type: 'file'; path: string; op: 'edit' | 'create' | 'delete' }[] {
  const out: { type: 'file'; path: string; op: 'edit' | 'create' | 'delete' }[] = [];
  const changes = Array.isArray(item.changes) ? item.changes : [];
  for (const change of changes) {
    if (!isRecord(change)) continue;
    const path = typeof change.path === 'string' ? change.path : undefined;
    if (!path) continue;
    out.push({ type: 'file', path, op: normaliseOp(change.kind ?? change.type) });
  }
  if (out.length === 0 && typeof item.path === 'string') {
    out.push({ type: 'file', path: item.path, op: normaliseOp(item.kind) });
  }
  return out;
}

function normaliseOp(kind: unknown): 'edit' | 'create' | 'delete' {
  const k = typeof kind === 'string' ? kind.toLowerCase() : '';
  if (k.includes('add') || k.includes('create') || k.includes('new')) return 'create';
  if (k.includes('delete') || k.includes('remove')) return 'delete';
  return 'edit';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function normaliseUsage(usage: Record<string, unknown>): Usage {
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cached = num(usage.cached_input_tokens);
  const total =
    input === undefined && output === undefined ? undefined : (input ?? 0) + (output ?? 0);
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    totalTokens: total,
  };
}
