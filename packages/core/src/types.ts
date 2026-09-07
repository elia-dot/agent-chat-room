/**
 * The published adapter contract: a contributor adding a runtime implements `AgentAdapter`
 * and nothing else. `CONTRIBUTING.md` walks through it, so changing anything here means
 * changing that guide too.
 */

/** What an adapter is allowed to do during a turn. Mapped to vendor flags in `permissions.ts`. */
export type Permission = 'read-only' | 'edits' | 'full';

/** A JSON Schema document, passed to a runtime's structured-output flag. */
export type JsonSchema = Record<string, unknown>;

/** Token accounting, normalised across runtimes. All fields are best effort. */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}

/** The result of `AgentAdapter.detect()`, rendered by `acr doctor`. */
export interface Detection {
  installed: boolean;
  version?: string;
  /**
   * Presence-only login probe. `undefined` means "this adapter cannot tell without
   * spawning the CLI", which we never do during detection.
   */
  loggedIn?: boolean;
  minVersionOk: boolean;
  /** Absolute path of the resolved binary, when installed. */
  binPath?: string;
  /** Human readable explanation when something is off. */
  note?: string;
}

export interface TurnRequest {
  cwd: string;
  /** Extra absolute workspace roots explicitly granted by the room owner. */
  additionalDirs?: string[];
  prompt: string;
  /** Resume the runtime's own session instead of starting a fresh one. */
  sessionId?: string;
  permission: Permission;
  model?: string;
  /** Role instructions. Appended as a system prompt where the runtime supports it. */
  systemAppend?: string;
  /** Optional structured-output schema. Never on the critical path: see `verdict.ts`. */
  outputSchema?: JsonSchema;
  timeoutMs: number;
  /** Stable id used for the turn's raw JSONL log. Generated when omitted. */
  turnId?: string;
  /**
   * Load the developer's own CLI config (skills, plugins, MCP servers, instructions).
   * Undefined means true – parity with the terminal is the default.
   *
   * `false` is a best-effort narrowing, not isolation: what each CLI can decline varies,
   * and none of them decline everything. See `RepoConfigSchema.userConfig` and the
   * README table. It never widens `permission`, and sandboxed turns suppress hooks
   * regardless of this flag.
   */
  userConfig?: boolean;
}

export type TurnEvent =
  | { type: 'started'; sessionId: string }
  | { type: 'text'; text: string; final?: boolean }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'file'; path: string; op: 'edit' | 'create' | 'delete' }
  | { type: 'done'; text: string; usage?: Usage; structured?: unknown }
  | { type: 'error'; message: string; exitCode?: number };

export type EventSink = (event: TurnEvent) => void;

/** What a finished turn produced. Resolved by `TurnHandle.done`; never rejects. */
export interface TurnResult {
  ok: boolean;
  /** The runtime's final message text, or '' when the turn produced none. */
  text: string;
  sessionId?: string;
  usage?: Usage;
  structured?: unknown;
  exitCode: number | null;
  error?: string;
  /** Set when the turn ended because it was cancelled or hit `timeoutMs`. */
  cancelled?: boolean;
  timedOut?: boolean;
}

export interface TurnHandle {
  turnId: string;
  /** Ask the child to stop. Safe to call after the turn has already finished. */
  cancel(reason?: string): void;
  done: Promise<TurnResult>;
}

/** One entry in a runtime's model catalog. `id` is what goes on the command line. */
export interface ModelOption {
  id: string;
  /** What a human calls it, when the runtime gives us a nicer name than the id. */
  label?: string;
}

export interface AdapterCapabilities {
  systemAppendDelivery?: 'every-turn' | 'first-turn';
  resume: boolean;
  readOnly: boolean;
  structuredOutput: boolean;
  /**
   * Static fallback names for the model picker, used when the CLI cannot list its own
   * models. A seed for a `<select>`, never a validator: vendors ship models faster than
   * this array gets edited, and parameterised strings like `claude-opus-5[1m]` can never
   * be enumerated. See `models.ts`.
   */
  models?: string[];
}

export interface AgentAdapter {
  /** 'claude' | 'codex' | 'cursor' | ... */
  id: string;
  displayName: string;
  detect(): Promise<Detection>;
  capabilities: AdapterCapabilities;
  run(req: TurnRequest, sink: EventSink): TurnHandle;
  /**
   * Ask the CLI which models this account can actually use. Optional: only some vendors
   * offer a listing, and the ones that do reach the network to answer, so `models.ts`
   * caches the result and falls back to `capabilities.models` when it fails.
   */
  listModels?(): Promise<ModelOption[]>;
}

/**
 * Per-turn stream parser. One instance per turn, owned by `runTurn`, so parsers are free
 * to keep mutable state (session id, last assistant message, pending tool names).
 */
export interface TurnParser {
  /** Called for every complete line the child wrote to stdout. Must never throw. */
  onLine(line: string, emit: EventSink): void;
  /** Called exactly once when the child has exited. Must never throw. */
  onExit(ctx: TurnExitContext, emit: EventSink): TurnResult;
}

export interface TurnExitContext {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Tail of the child's stderr, capped. */
  stderr: string;
  cancelled: boolean;
  timedOut: boolean;
  /** Set when the child could not be spawned at all (e.g. ENOENT). */
  spawnError?: string;
}
