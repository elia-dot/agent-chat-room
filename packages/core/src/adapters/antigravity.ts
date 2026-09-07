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
import { agyPermissionArgs } from '../permissions.js';
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

/** Antigravity's binary is `agy`; the adapter id is the product, the way `cursor` is. */
export const AGY_BIN = 'agy';
export const AGY_MIN_VERSION = '1.1.0';

/**
 * Tool calls that mean a file on disk changed, taken from the tool list the `init` event
 * publishes. Antigravity names its tools in snake_case and does not decorate them, so these
 * are the names as they arrive.
 */
const WRITE_TOOLS = new Set([
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'sed_file',
  'notebook_edit',
]);

/**
 * Argv for one headless turn.
 *
 * Three of these flags are load-bearing in a way `--help` does not tell you, all probed
 * against agy 1.1.26:
 *
 *  - `--add-dir` is what binds the turn to the repo. The spawn `cwd` alone is not enough:
 *    with only `cwd` set the agent went hunting through `$HOME` and offered to write into
 *    `~/.gemini/antigravity-cli/scratch/`.
 *  - `--print-timeout` overrides agy's own `5m0s` default, which is shorter than a room's
 *    stall timeout – without it a long build turn is killed by the vendor, not by us.
 *  - `-p=` is the print flag with an *empty* value. `-p` takes a value, so `-p --output-format`
 *    is read as "the prompt is `--output-format`"; the empty form is what switches the
 *    prompt over to the NDJSON stdin `--input-format stream-json` reads.
 */
export function buildAgyArgs(req: TurnRequest): string[] {
  const args = [
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    // A room transcript that happens to contain a `/word` must stay text, not become a
    // command the CLI expands.
    //
    // The help text – "disable slash command and skill expansion in print mode" – reads
    // like this also costs a room its skills. Measured against agy 1.1.26, it does not.
    // With a skill installed at `~/.gemini/config/skills/zebra-probe/` and an empty
    // workspace, a turn asked to name its skills *without opening any files* answered
    // `agy-customizations, antigravity-guide, zebra-probe` both with the flag and
    // without it, and used the skill's content correctly either way. What the flag stops
    // is explicit `/name` invocation, which a room never issues; skills stay discoverable
    // and loadable on their own. So the guard is kept unconditionally – it is free.
    '--disable-slash-commands',
    '--add-dir',
    req.cwd,
    ...(req.additionalDirs ?? []).flatMap((path) => ['--add-dir', path]),
    '--print-timeout',
    `${Math.max(1, Math.ceil(req.timeoutMs / 1000))}s`,
    ...agyPermissionArgs(req.permission),
  ];
  if (req.model) args.push('--model', req.model);
  if (req.sessionId) args.push('--conversation', req.sessionId);
  // `--json-schema` exists but only shapes the final text, and there is no structured field
  // on the `result` event to read it back from. `capabilities.structuredOutput` is false and
  // the fenced verdict block carries the decision instead (see `verdict.ts`).
  args.push('-p=');
  return args;
}

/**
 * Antigravity has no system-prompt flag, exactly like Codex and Cursor, so role
 * instructions are prepended to the first turn's prompt. A resumed conversation already
 * carries them.
 */
export function buildAgyPrompt(req: TurnRequest): string {
  const parts: string[] = [];
  if (req.systemAppend && !req.sessionId) parts.push(req.systemAppend.trim(), '---');
  if (req.permission === 'read-only') {
    parts.push(
      'Antigravity read-only constraint: do not call run_command, including for Git, tests, ' +
        'builds, or package managers. Use list_dir and view_file for repository inspection, ' +
        'and always finish with a textual answer even if a read action is denied.',
    );
  } else if (req.permission === 'edits') {
    parts.push(
      'Antigravity edit constraint: use write_to_file, replace_file_content, or ' +
        'multi_replace_file_content for every project-file write. Do not write through ' +
        'run_command, shell redirection, or heredocs; accept-edits may deny those commands. ' +
        'Use run_command only for builds, tests, and read-only inspection. If any tool is ' +
        'denied, continue with allowed tools and always finish with a textual summary.',
    );
  }
  parts.push(req.prompt);
  return parts.join('\n\n');
}

/**
 * The one NDJSON line `--input-format stream-json` expects on stdin. Plain stdin is not
 * supported – agy answers `empty prompt` – so this envelope is the only way to hand over a
 * room-sized transcript without pushing it through argv and into `ARG_MAX`.
 */
export function buildAgyStdin(req: TurnRequest): string {
  return `${JSON.stringify({
    event: 'user',
    message: { role: 'user', content: buildAgyPrompt(req) },
  })}\n`;
}

export function buildAgyListModelsArgs(): string[] {
  return ['models'];
}

/**
 * Parse `agy models`, probed against agy 1.1.26:
 *
 * ```
 * Fetching available models...
 * gemini-3.1-pro-high\tGemini 3.1 Pro (High)
 * ```
 *
 * A row is `<id>\t<Label>`. Matching that shape rather than a line number means the banner,
 * blank lines and whatever a future release prints alongside are skipped for free instead
 * of becoming a model nobody can select.
 */
export function parseAgyModels(stdout: string): ModelOption[] {
  const models: ModelOption[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split('\n')) {
    const at = raw.indexOf('\t');
    if (at <= 0) continue;
    const id = raw.slice(0, at).trim();
    const label = raw.slice(at + 1).trim();
    // Ids are command-line tokens: a row with a space on the left is prose, not a model.
    if (id.length === 0 || /\s/.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push(label ? { id, label } : { id });
  }
  return models;
}

/**
 * Parser for `agy --output-format stream-json`.
 *
 * Shapes probed live against agy 1.1.26 and recorded in `test/fixtures/agy_run.jsonl`. The
 * envelope is unlike the other three runtimes': there is no top-level `type`, events are
 * keyed by `event`, and everything interesting arrives as a `step_update` whose `step_type`
 * says what kind of step it is.
 *
 *  - `init` carries `conversation_id`, which is the resume handle.
 *  - `step_update` / `agent_response` carries the answer as `text_delta` chunks. Steps that
 *    are pure reasoning carry no delta, so accumulating them reproduces the message.
 *  - `step_update` / `tool` comes in `ACTIVE` then `DONE`-or-`ERROR` pairs, with PascalCase
 *    parameters (`TargetFile`, `CommandLine`, …) under `tool_info`.
 *  - `result` carries the authoritative response text, a run-cumulative usage block, and a
 *    `status` of `SUCCESS` | `ERROR` | `CANCELED`.
 *
 * Anything else – an unknown `event`, an unknown `step_type`, a `jetski:` diagnostic line –
 * is ignored rather than treated as a failure. This format is young and will move.
 */
export class AntigravityParser implements TurnParser {
  private sessionId: string | undefined;
  private finalText = '';
  private streamedText = '';
  private usage: Usage | undefined;
  private errorMessage: string | undefined;
  private deniedActions: string[] = [];

  /** The model this turn asked for, so a rejection can name it. */
  constructor(private readonly model?: string) {}

  onLine(line: string, emit: EventSink): void {
    const ev = parseJsonLine(line);
    if (!ev) return;

    switch (ev.event) {
      case 'init':
        this.captureSessionId(ev.conversation_id, emit);
        if (isRecord(ev.init)) this.captureSessionId(ev.init.conversation_id, emit);
        return;
      case 'step_update':
        this.onStepUpdate(ev.step_update, emit);
        return;
      case 'result':
        this.onResult(ev.result, emit);
        return;
      default:
        // Unknown top-level event. Recorded in the turn log, never fatal – an adapter that
        // throws on one breaks every room on the next CLI upgrade.
        this.captureSessionId(ev.conversation_id, emit);
    }
  }

  private captureSessionId(id: unknown, emit: EventSink): void {
    if (this.sessionId) return;
    if (typeof id === 'string' && id.length > 0) {
      this.sessionId = id;
      emit({ type: 'started', sessionId: id });
    }
  }

  private onStepUpdate(raw: unknown, emit: EventSink): void {
    if (!isRecord(raw)) return;
    this.captureSessionId(raw.conversation_id, emit);

    switch (raw.step_type) {
      case 'agent_response': {
        const delta = raw.text_delta;
        // Both `ACTIVE` and the closing `DONE` carry a delta; reasoning-only steps carry
        // none. Appending whatever is there is what reproduces the final message.
        if (typeof delta !== 'string' || delta.length === 0) return;
        this.streamedText += delta;
        emit({ type: 'text', text: delta });
        return;
      }
      case 'tool':
        this.onToolStep(raw, emit);
        return;
      default:
        // `user_input` is our own prompt echoed back, `system_message` is chrome, and a
        // step_type from a future release is none of our business.
        return;
    }
  }

  private onToolStep(step: Record<string, unknown>, emit: EventSink): void {
    const info = isRecord(step.tool_info) ? step.tool_info : {};
    const name = strOrUndefined(step.tool_name) ?? strOrUndefined(info.name) ?? 'tool';
    const params = isRecord(info.parameters) ? info.parameters : {};

    if (step.state === 'ACTIVE') {
      emit({ type: 'tool', name, summary: summariseToolParams(params) });
      return;
    }
    if (step.state !== 'DONE' && step.state !== 'ERROR') return;

    const failed = step.state === 'ERROR';
    const detail = failed ? toolErrorMessage(info.error) : 'ok';
    emit({ type: 'tool', name, summary: `→ ${truncate(detail, 160)}` });

    const path = filePathFrom(params);
    if (!failed && path && WRITE_TOOLS.has(name)) {
      emit({ type: 'file', path, op: fileOpFor(name) });
    }
  }

  private onResult(raw: unknown, emit: EventSink): void {
    if (!isRecord(raw)) return;
    this.captureSessionId(raw.conversation_id, emit);
    if (typeof raw.response === 'string') this.finalText = raw.response;
    if (isRecord(raw.usage)) this.usage = normaliseUsage(raw.usage);
    this.deniedActions = deniedActionNames(raw.denied_actions);

    if (raw.status !== 'SUCCESS') {
      const status = strOrUndefined(raw.status) ?? 'unknown';
      const reported = strOrUndefined(raw.error) ?? strOrUndefined(raw.response);
      this.errorMessage =
        reported && reported.length > 0 ? reported : `${AGY_BIN} reported status ${status}`;
    }
  }

  onExit(ctx: TurnExitContext, emit: EventSink): TurnResult {
    const base = {
      text: this.finalText || this.streamedText,
      sessionId: this.sessionId,
      usage: this.usage,
      exitCode: ctx.exitCode,
    };

    const failure = failureReason(ctx, this.errorMessage, AGY_BIN);
    if (failure) return { ...base, ok: false, error: withModelHint(failure, this.model) };
    if (base.text.length === 0) {
      // A `SUCCESS` with an empty response is real: a denied tool ends the turn that way.
      // Following the cursor precedent, that is a failed turn with a reason rather than an
      // empty bubble in the room – and the reason is the useful part, so it names the
      // permission that got in the way when agy told us which one it was.
      const denied =
        this.deniedActions.length > 0
          ? ` (agy denied: ${this.deniedActions.join(', ')} – this turn's permission level does not allow it)`
          : '';
      return { ...base, ok: false, error: `${AGY_BIN} produced no message${denied}` };
    }

    emit({ type: 'done', text: base.text, usage: this.usage });
    return { ...base, ok: true };
  }
}

export const antigravityAdapter: AgentAdapter = {
  id: 'antigravity',
  displayName: 'Antigravity',
  capabilities: {
    systemAppendDelivery: 'first-turn',
    resume: true,
    readOnly: true,
    // `--json-schema` exists, but it only shapes the final text and the `result` event has
    // no structured field to read back, so there is nothing to hand to the engine.
    structuredOutput: false,
    // Only a fallback for when `agy models` cannot be reached (offline, logged out). The
    // real list comes from the CLI; this one goes stale, so it seeds the picker and
    // validates nothing.
    models: [
      'gemini-3.1-pro-high',
      'gemini-3.8-flash-medium',
      'claude-sonnet-4-6',
      'gpt-oss-120b-medium',
    ],
  },

  /**
   * `agy models` reaches the network to answer, exactly like `cursor-agent --list-models`,
   * so it gets the same 10 s probe timeout and `models.ts` caches the result. A failure
   * returns an empty list, which the caller reads as "fall back to the static names".
   */
  async listModels(): Promise<ModelOption[]> {
    const binPath = which(AGY_BIN);
    if (!binPath) return [];
    const out = await readStdout(binPath, buildAgyListModelsArgs());
    return out === undefined ? [] : parseAgyModels(out);
  },

  async detect(): Promise<Detection> {
    const binPath = which(AGY_BIN);
    if (!binPath) {
      return {
        installed: false,
        minVersionOk: false,
        note: `\`${AGY_BIN}\` is not on your PATH`,
      };
    }
    const version = await readVersion(binPath, ['--version']);
    return {
      installed: true,
      binPath,
      version,
      minVersionOk: meetsMinVersion(version, AGY_MIN_VERSION),
      // Presence only, like every other adapter: this is where the Antigravity login puts
      // its OAuth credentials, and we check that it is there without opening it.
      loggedIn: credentialPresent([join(home(), '.gemini', 'oauth_creds.json')]),
      note:
        version && !meetsMinVersion(version, AGY_MIN_VERSION)
          ? `needs >= ${AGY_MIN_VERSION}`
          : undefined,
    };
  },

  run(req: TurnRequest, sink: EventSink): TurnHandle {
    return runTurn({
      argv: [AGY_BIN, ...buildAgyArgs(req)],
      cwd: req.cwd,
      stdin: buildAgyStdin(req),
      timeoutMs: req.timeoutMs,
      parser: new AntigravityParser(req.model),
      sink,
      turnId: req.turnId,
    });
  },
};

// --- helpers ---------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function strOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Antigravity's tool parameters are PascalCase, which is why this list is its own. */
function filePathFrom(params: Record<string, unknown>): string | undefined {
  for (const key of ['TargetFile', 'AbsolutePath', 'FilePath', 'Path']) {
    const v = params[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function fileOpFor(name: string): 'edit' | 'create' | 'delete' {
  // `write_to_file` creates the file when it is not there and rewrites it when it is; the
  // event stream does not say which, and "create" is the honest reading of the tool name.
  return name === 'write_to_file' ? 'create' : 'edit';
}

function summariseToolParams(params: Record<string, unknown>): string {
  if (typeof params.CommandLine === 'string') return truncate(params.CommandLine, 160);
  const path = filePathFrom(params);
  if (path) return path;
  for (const key of ['Query', 'Pattern', 'SearchDirectory', 'DirectoryPath']) {
    const v = params[key];
    if (typeof v === 'string' && v.length > 0) return truncate(v, 160);
  }
  return '';
}

/** An `ERROR` step carries `{ error: { type, message } }`; older shapes carry a string. */
function toolErrorMessage(error: unknown): string {
  if (typeof error === 'string' && error.length > 0) return error;
  if (isRecord(error)) {
    return strOrUndefined(error.message) ?? strOrUndefined(error.type) ?? 'failed';
  }
  return 'failed';
}

/**
 * `result.denied_actions` is `[{ action, display_name }]` when headless mode had to
 * auto-deny a tool it could not prompt for. Naming those turns "no message" into "the
 * shell was blocked".
 */
function deniedActionNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = strOrUndefined(entry.display_name) ?? strOrUndefined(entry.action);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/**
 * Antigravity reports snake_case token counts, cumulative for the whole run rather than for
 * the last step, so `total_tokens` can be used as it arrives. `thinking_tokens` has no home
 * in `Usage` and is dropped.
 */
function normaliseUsage(usage: Record<string, unknown>): Usage {
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cached = num(usage.cache_read_tokens);
  const total =
    num(usage.total_tokens) ??
    (input === undefined && output === undefined ? undefined : (input ?? 0) + (output ?? 0));
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    totalTokens: total,
  };
}
