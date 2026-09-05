# Contributing to agent-chat-room

Thank you for your interest in contributing to `agent-chat-room`!

## Getting Started

### Prerequisites
- Node.js >= 20.19 (LTS)
- npm >= 10
- git

### Development Setup
```bash
git clone https://github.com/elia-dot/agent-chat-room.git
cd agent-chat-room
npm install
npm run build
npm test
npm run lint
```

---

## Writing a New Agent Adapter

Every agent CLI supported by `agent-chat-room` implements the `AgentAdapter` interface defined in [`packages/core/src/types.ts`](packages/core/src/types.ts).

Adapters are pure data/function structures that translate between `agent-chat-room`'s lifecycle and the target agent CLI's command-line flags and output stream.

### The `AgentAdapter` Interface

```typescript
export interface AgentAdapter {
  readonly id: string;
  detect(): Promise<Detection>;
  run(request: TurnRequest, sink: EventSink): TurnHandle;
  listModels?(): Promise<string[]>;
}
```

### Key Components

1. **`detect()`**: Probes whether the agent CLI is installed on `PATH`, checks minimum required versions, and verifies that credentials or authentication state files exist. Detection must never perform unauthorized network calls or prompt for logins.
2. **`run(request, sink)`**: Spawns or executes a turn for the agent.
   - `request.cwd`: The working directory (usually a git worktree).
   - `request.prompt`: The formatted turn prompt provided via stdin.
   - `request.permission`: `read-only`, `edits`, or `full`.
   - `sink(event)`: Emits streaming events (`text`, `tool`, `file`, `error`, `done`).
   - Returns a `TurnHandle` containing `{ turnId, done, cancel }`.
3. **`listModels()`** (Optional): Queries the runtime for available models.

### Reference Implementations
- **`echo.ts`** ([`packages/core/src/adapters/echo.ts`](packages/core/src/adapters/echo.ts)): The mock adapter used for hermetic testing. It demonstrates handling turns, emitting lifecycle events, reading prompt headers, and creating mock files.
- **`claude.ts`**, **`codex.ts`**, **`cursor.ts`**, **`antigravity.ts`**: Production adapters driving real CLIs.

---

## Code Quality & Testing Guidelines

- Run `npm test` before submitting changes. All core tests run hermetically without external network dependencies.
- Ensure type checks pass: `npm run typecheck`.
- Format code according to repository standards: `npm run format:check`.
