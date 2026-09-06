import { join } from 'node:path';

import {
  credentialPresent,
  home,
  meetsMinVersion,
  readStdout,
  readVersion,
  which,
} from '../detect.js';
import { withModelHint } from '../modelHint.js';
import { opencodePermissionConfig } from '../permissions.js';
import { parseJsonLine } from '../process/lines.js';
import { runTurn } from '../process/runTurn.js';
import type {
  AgentAdapter,
  Detection,
  EventSink,
  ModelOption,
  TurnExitContext,
  TurnHandle,
  TurnParser,
  TurnRequest,
  TurnResult,
  Usage,
} from '../types.js';
import { failureReason } from './claude.js';

export const OPENCODE_BIN = 'opencode';
/** The version every shape in this file was probed against. */
export const OPENCODE_MIN_VERSION = '1.18.0';

/** Tool calls that mean a file on disk changed. */
const WRITE_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit']);

export function buildOpencodeArgs(req: TurnRequest): string[] {
  // `--auto` at every level, not just `full`. It auto-approves anything the config does not
  // explicitly deny, and a headless room turn has nobody to answer an approval prompt – a
  // turn that blocks on one would burn its stall timeout and die for no reason. The denials
  // in `opencodePermissionConfig` outrank it, which is the probe recorded there.
  const args = ['run', '--format', 'json', '--auto'];
  if (req.model) args.push('-m', req.model);
  if (req.sessionId) args.push('-s', req.sessionId);
  // No `--output-schema` equivalent: `capabilities.structuredOutput` is false and the fenced
  // verdict block carries the decision, which `verdict.ts` says is the real contract.
  return args;
}

/**
 * The permission table travels as a config document in the environment.
 *
 * `OPENCODE_CONFIG_CONTENT` is deliberately the whole mechanism: it beats the target repo's
 * own `opencode.json` (probed), so a room's permission level cannot be widened by the
 * repository it is pointed at. The repo's config is otherwise left alone – its AGENTS.md and
 * MCP servers are a legitimate part of the project being worked on, unlike a *user's*
 * personal instructions, which is the thing `codex.ts` has to shut out with
 * `--ignore-user-config`.
 */
export function buildOpencodeEnv(
  req: TurnRequest,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission: opencodePermissionConfig(req.permission),
    }),
  };
}

/**
 * opencode has no system-prompt flag – `--agent` names a persona defined in config, not
 * inline text – so role instructions are prepended to the first turn's prompt exactly like
 * Codex and Cursor. On a resumed turn the session already carries them.
 */
export function buildOpencodePrompt(req: TurnRequest): string {
  if (!req.systemAppend || req.sessionId) return req.prompt;
  return `${req.systemAppend.trim()}\n\n---\n\n${req.prompt}`;
}

export function buildOpencodeListModelsArgs(): string[] {
  return ['models'];
}

/**
 * Parse `opencode models`, probed against opencode 1.18.20: one bare `provider/model` id per
 * line, no labels and no header, which is why this is the simplest listing of any adapter.
 *
 * The ids are already exactly what `-m` wants, so they pass through untouched. Anything that
 * is not a single `provider/model` token – a banner, a warning `readStdout` folded in from
 * stderr – is skipped rather than turned into a model nobody can select.
 */
export function parseOpencodeModels(stdout: string): ModelOption[] {
  const models: ModelOption[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split('\n')) {
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) continue;
    if (!/^[\w.-]+\/[\w.:-]+$/.test(id)) continue;
    seen.add(id);
    models.push({ id });
  }
  return models;
}

/**
 * Parser for `opencode run --format json`.
 *
 * Shapes probed live against opencode 1.18.20. It is JSONL, one event per line, and every
 * event carries a top-level `sessionID`:
 *
 *  - `step_start` / `step_finish` bracket each step of the agent loop. A turn that calls
 *    tools produces several. `step_finish.part.tokens` carries per-step usage, so the totals
 *    here accumulate rather than overwrite.
 *  - `text` carries a whole message part, not a delta – the probe that asked for the numbers
 *    1 to 10 produced a single event holding all ten lines. Text still reaches the sink as it
 *    arrives, so a multi-step turn streams; a single-step one lands in one piece.
 *  - `tool_use` carries `part.tool` and `part.state`, the latter holding `input` before and
 *    `output` after. The synthetic tool named `invalid` is how a *denied* tool surfaces, and
 *    it is worth showing: it is the visible consequence of the room's permission level.
 *  - `error` is top level, not inside `part`, and pairs with a non-zero exit.
 *
 * Anything else is ignored rather than treated as a failure. An adapter that throws on an
 * unknown event type is an adapter that breaks on every CLI upgrade.
 */
export class OpencodeParser implements TurnParser {
  private sessionId: string | undefined;
  private streamedText = '';
  private usage: Usage | undefined;
  private errorMessage: string | undefined;
  private sawText = false;

  /** The model this turn asked for, so a rejection can name it. */
  constructor(private readonly model?: string) {}

  onLine(line: string, emit: EventSink): void {
    const ev = parseJsonLine(line);
    if (!ev) return;
    this.captureSessionId(ev, emit);

    switch (typeof ev.type === 'string' ? ev.type : '') {
      case 'text':
        this.onText(ev, emit);
        return;
      case 'tool_use':
        this.onToolUse(ev, emit);
        return;
      case 'step_finish':
        this.onStepFinish(ev);
        return;
      case 'error':
        this.onError(ev);
        return;
      default:
        // `step_start`, `reasoning`, and whatever the next release adds. Recorded in the
        // turn log, never surfaced and never fatal.
        return;
    }
  }

  private captureSessionId(ev: Record<string, unknown>, emit: EventSink): void {
    if (this.sessionId) return;
    const id = ev.sessionID;
    if (typeof id === 'string' && id.length > 0) {
      this.sessionId = id;
      emit({ type: 'started', sessionId: id });
    }
  }

  private onText(ev: Record<string, unknown>, emit: EventSink): void {
    const part = isRecord(ev.part) ? ev.part : undefined;
    const text = part && typeof part.text === 'string' ? part.text : '';
    if (text.length === 0) return;
    this.sawText = true;
    // The separator goes into the emitted chunk, not just the accumulator: the live view is
    // built from these deltas and the stored message from `result.text`, so anything added
    // to one and not the other makes the room show two different messages.
    const chunk = this.streamedText.length > 0 ? `\n${text}` : text;
    this.streamedText += chunk;
    emit({ type: 'text', text: chunk });
  }

  private onToolUse(ev: Record<string, unknown>, emit: EventSink): void {
    const part = isRecord(ev.part) ? ev.part : undefined;
    if (!part) return;
    const name = typeof part.tool === 'string' ? part.tool : 'tool';
    const state = isRecord(part.state) ? part.state : {};
    const input = isRecord(state.input) ? state.input : {};

    // A denied tool arrives as the synthetic `invalid` tool, carrying the name it wanted in
    // `input.tool` and the refusal in `input.error`. Reporting it under the real name makes
    // "the reviewer tried to run the tests and could not" legible in the transcript.
    if (name === 'invalid') {
      const wanted = typeof input.tool === 'string' ? input.tool : 'tool';
      const why = typeof input.error === 'string' ? input.error : 'unavailable';
      emit({ type: 'tool', name: wanted, summary: `→ blocked: ${truncate(why, 160)}` });
      return;
    }

    if (state.status !== 'completed') {
      emit({ type: 'tool', name, summary: summariseToolInput(name, input) });
      return;
    }

    // opencode buffers a call and its result into one event, so unlike Claude and Cursor
    // there is no started/completed pair to render as two lines. Both halves go in one
    // summary – `math.js → ok`, `**/package.json → No files found` – which says more than
    // either half alone.
    const what = summariseToolInput(name, input);
    const outcome = summariseToolOutput(state);
    emit({ type: 'tool', name, summary: what ? `${what} → ${outcome}` : `→ ${outcome}` });

    const path = filePathFrom(input);
    if (WRITE_TOOLS.has(name) && path) {
      emit({ type: 'file', path, op: name === 'write' ? 'create' : 'edit' });
    }
  }

  /** Usage is reported per step, so a multi-step turn adds up rather than reporting its last. */
  private onStepFinish(ev: Record<string, unknown>): void {
    const part = isRecord(ev.part) ? ev.part : undefined;
    const tokens = part && isRecord(part.tokens) ? part.tokens : undefined;
    if (!tokens) return;
    const cache = isRecord(tokens.cache) ? tokens.cache : {};
    this.usage = addUsage(this.usage, {
      inputTokens: num(tokens.input),
      outputTokens: num(tokens.output),
      cachedInputTokens: num(cache.read),
    });
  }

  /**
   * `error` is the one event whose payload is top level rather than under `part`.
   *
   * Known rough edge, recorded in `opencode_failed.jsonl`: a model the account cannot use
   * comes back as a generic `UnknownError` / "Unexpected server error", worded exactly like
   * a gateway outage. `withModelHint` therefore cannot tell the user their `-m` was the
   * problem, and deliberately does not guess.
   */
  private onError(ev: Record<string, unknown>): void {
    const err = isRecord(ev.error) ? ev.error : undefined;
    const data = err && isRecord(err.data) ? err.data : undefined;
    const message = data && typeof data.message === 'string' ? data.message : undefined;
    const name = err && typeof err.name === 'string' ? err.name : 'error';
    this.errorMessage = message ? `${name}: ${message}` : `opencode reported ${name}`;
  }

  onExit(ctx: TurnExitContext, emit: EventSink): TurnResult {
    const base = {
      text: this.streamedText,
      sessionId: this.sessionId,
      usage: this.usage,
      exitCode: ctx.exitCode,
    };

    const failure = failureReason(ctx, this.errorMessage, OPENCODE_BIN);
    if (failure) return { ...base, ok: false, error: withModelHint(failure, this.model) };
    if (!this.sawText && base.text.length === 0) {
      return { ...base, ok: false, error: 'opencode produced no message' };
    }

    emit({ type: 'done', text: base.text, usage: this.usage });
    return { ...base, ok: true };
  }
}

export const opencodeAdapter: AgentAdapter = {
  id: 'opencode',
  displayName: 'opencode',
  capabilities: {
    // No inline system-prompt flag, so role instructions ride the first prompt of a session.
    systemAppendDelivery: 'first-turn',
    resume: true,
    readOnly: true,
    // `--format json` has no structured-output flag and no field on any event to read one
    // back from, so there is nothing to hand the engine.
    structuredOutput: false,
    // Only a fallback for when `opencode models` cannot be reached (offline, logged out).
    // The real list comes from the CLI and is account-specific: it depends on which
    // providers you logged in to, so these ids are the OpenCode Zen ones a fresh install
    // gets. It seeds the picker and validates nothing.
    models: [
      'opencode/claude-opus-5',
      'opencode/claude-sonnet-5',
      'opencode/gpt-5.6-sol',
      'opencode/gemini-3.8-flash',
      'opencode/nemotron-3.5-lightning-free',
    ],
  },

  /**
   * `opencode models` answers from the providers you are logged in to, so it is worth asking
   * rather than hard-coding. It gets the same 10 s probe timeout as the other listings and
   * `models.ts` caches the result; a failure returns an empty list, which the caller reads as
   * "fall back to the static names".
   */
  async listModels(): Promise<ModelOption[]> {
    const binPath = which(OPENCODE_BIN);
    if (!binPath) return [];
    const out = await readStdout(binPath, buildOpencodeListModelsArgs());
    return out === undefined ? [] : parseOpencodeModels(out);
  },

  async detect(): Promise<Detection> {
    const binPath = which(OPENCODE_BIN);
    if (!binPath) {
      return {
        installed: false,
        minVersionOk: false,
        note: `\`${OPENCODE_BIN}\` is not on your PATH`,
      };
    }
    const version = await readVersion(binPath, ['--version']);
    return {
      installed: true,
      binPath,
      version,
      minVersionOk: meetsMinVersion(version, OPENCODE_MIN_VERSION),
      // Presence only, like every other adapter: one file holds every provider's credential,
      // whichever one you logged in to, and we check that it is there without opening it.
      loggedIn: credentialPresent([join(home(), '.local', 'share', 'opencode', 'auth.json')]),
      note:
        version && !meetsMinVersion(version, OPENCODE_MIN_VERSION)
          ? `needs >= ${OPENCODE_MIN_VERSION}`
          : undefined,
    };
  },

  run(req: TurnRequest, sink: EventSink): TurnHandle {
    return runTurn({
      argv: [OPENCODE_BIN, ...buildOpencodeArgs(req)],
      cwd: req.cwd,
      // `opencode run` takes its message as a trailing positional *or* on stdin. Probed: with
      // no positional it reads stdin and answers normally. Stdin is what this adapter uses,
      // for the reason PLAN.md section 9 gives – room transcripts can exceed a comfortable
      // argv size, and macOS `ARG_MAX` is about a megabyte.
      stdin: buildOpencodePrompt(req),
      timeoutMs: req.timeoutMs,
      parser: new OpencodeParser(req.model),
      sink,
      turnId: req.turnId,
      env: buildOpencodeEnv(req),
    });
  },
};

// --- helpers ---------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function addUsage(a: Usage | undefined, b: Usage): Usage {
  const sum = (x: number | undefined, y: number | undefined): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const inputTokens = sum(a?.inputTokens, b.inputTokens);
  const outputTokens = sum(a?.outputTokens, b.outputTokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: sum(a?.cachedInputTokens, b.cachedInputTokens),
    totalTokens:
      inputTokens === undefined && outputTokens === undefined
        ? undefined
        : (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

function filePathFrom(input: Record<string, unknown>): string | undefined {
  for (const key of ['filePath', 'file_path', 'path']) {
    const v = input[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function summariseToolInput(name: string, input: Record<string, unknown>): string {
  if (name === 'bash' && typeof input.command === 'string') return truncate(input.command, 160);
  const path = filePathFrom(input);
  if (path) return path;
  if (typeof input.pattern === 'string') return input.pattern;
  const keys = Object.keys(input);
  return keys.length > 0 ? truncate(JSON.stringify(input), 160) : '';
}

function summariseToolOutput(state: Record<string, unknown>): string {
  const output = typeof state.output === 'string' ? state.output : '';
  // `read` answers with `<path>…</path>` and then the file body. The path is already the
  // left-hand side of the summary, so echoing it back adds a long line that says nothing.
  if (output.startsWith('<path>')) return 'ok';
  const firstLine = output.split('\n').find((l) => l.trim().length > 0) ?? '';
  return truncate(firstLine.trim(), 160) || 'ok';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
