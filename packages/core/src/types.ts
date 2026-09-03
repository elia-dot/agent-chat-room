/**
 * The published adapter contract. These declarations are the ones written down in
 * `docs/PLAN.md` section 4.1 – a contributor adding a runtime implements `AgentAdapter`
 * and nothing else. Changing anything here means changing the plan too.
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

export interface AdapterCapabilities {
  resume: boolean;
  readOnly: boolean;
  structuredOutput: boolean;
  models?: string[];
}

export interface AgentAdapter {
  /** 'claude' | 'codex' | 'cursor' | ... */
  id: string;
  displayName: string;
  detect(): Promise<Detection>;
  capabilities: AdapterCapabilities;
  run(req: TurnRequest, sink: EventSink): TurnHandle;
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
