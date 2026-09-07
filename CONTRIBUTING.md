# Contributing to agent-chat-room

Thank you for your interest in contributing to `agent-chat-room`!

## Issues and pull requests

[Open an issue](https://github.com/elia-dot/agent-chat-room/issues) for bugs or feature requests.
Include reproduction steps, ACR/Node/agent CLI versions, and expected versus actual behavior.
Remove tokens, private paths and sensitive transcript content from logs and screenshots.
Report vulnerabilities using [SECURITY.md](SECURITY.md).

For a pull request, fork the repository, make a focused change, and open a PR against `main`.
Explain the problem and what checks you ran; add regression coverage for behavior changes.
Discuss large changes in an issue first. Contributions are under the repository's MIT license.

## Getting Started

### Prerequisites

- Node.js >= 20.19 (LTS)
- npm >= 10
- git

### Development Setup

```bash
git clone https://github.com/elia-dot/agent-chat-room.git
cd agent-chat-room
npm ci
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
  id: string;
  displayName: string;
  capabilities: AdapterCapabilities;
  detect(): Promise<Detection>;
  run(request: TurnRequest, sink: EventSink): TurnHandle;
  listModels?(): Promise<ModelOption[]>;
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
- **`claude.ts`**, **`codex.ts`**, **`cursor.ts`**, **`antigravity.ts`**, **`opencode.ts`**: Production adapters driving real CLIs.

### Adding a Runtime

Registering one is a single line in [`packages/core/src/adapters/index.ts`](packages/core/src/adapters/index.ts) plus a file next to it. Everything downstream is data-driven off `adapterList`: the web model picker, `GET /api/runtimes` and `acr doctor` all pick a new runtime up without changes. In practice a new adapter also wants a permission mapping in [`permissions.ts`](packages/core/src/permissions.ts), a colour in `packages/cli/src/render.ts`, and a recorded JSONL fixture under [`packages/core/test/fixtures`](packages/core/test/fixtures) so a CLI that changes its event shapes fails a test instead of silently going quiet.

Probe the real CLI rather than trusting `--help`, and write down what you found: every permission row in `permissions.ts` records an actual probe, because the difference between a flag that refuses a write and one that merely says it will is the difference between a reviewer that can be trusted and one that cannot. `opencode.ts` is the adapter to copy when a runtime expresses permissions as configuration instead of flags; `cursor.ts` when it has no system-prompt flag; `codex.ts` when resuming uses a different subcommand.

---

## Code Quality & Testing Guidelines

- Run `npm test` before submitting changes. All core tests run hermetically without external network dependencies.
- Ensure type checks pass: `npm run typecheck`.
- Format code according to repository standards: `npm run format:check`.
