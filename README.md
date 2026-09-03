# agent-chat-room

Turn the "two terminals, one Claude, one Codex, ping-pong until it's done" workflow into a room:
you post a task, one agent builds, the others review, and they iterate until they agree or you
step in.

Every agent runs through the CLI you already have installed and logged in, so it works on your
existing subscriptions. **No API keys.** `acr` never reads your credentials – it only checks that
a credentials file exists, and lets each CLI find its own login the way it normally does.

The full design lives in [`docs/PLAN.md`](docs/PLAN.md).

## Status: milestone M1

M1 is "the room engine". What works today:

- **Adapters** for Claude Code and Codex CLI: `detect()`, argv building, streaming `run()`, session
  resume, and a permission model with exactly three levels (`read-only`, `edits`, `full`).
- **`acr doctor`** – which runtimes are installed, new enough and logged in.
- **`acr run`** – a whole room: the worker builds, every reviewer reviews in parallel, and the loop
  repeats until they all approve, someone asks you a question, or the rounds run out.
- **Git worktrees.** Every room runs in its own worktree on branch `acr/<slug>`, so your checkout is
  never touched and a room's diff is attributable to that room by construction.
- **Auto-commit on approve.** The round everyone approved is committed on the room branch with the
  worker's summary as the body, so a room's work is never sitting only in a working tree.
- **SQLite persistence.** Rooms, participants, messages, turns and recent repos live in
  `~/.config/agent-chat-room/acr.db`, and `acr rooms` reads them back.
- **Restart recovery.** A turn that died with its process is marked, its round is rolled back and
  re-run, and each agent keeps its own runtime session – so only the turn is repeated, not the
  conversation.
- **`.acr.json`** – optional, committed per-repo defaults.

Not here yet: the server, the WebSocket and the web UI (M2), plus the Cursor adapter, brainstorm
mode and role swapping (M3).

## Try it

```sh
nvm use            # Node 22.14 (>= 20.19 works)
npm install
npm run build

node packages/cli/dist/bin.js doctor
node packages/cli/dist/bin.js run \
  --task "The login test is flaky. Find out why and fix it." \
  --agents claude,codex \
  --rounds 3 \
  --cwd ~/code/your-repo

node packages/cli/dist/bin.js rooms ls
node packages/cli/dist/bin.js rooms show <id>
node packages/cli/dist/bin.js rooms resume <id>
node packages/cli/dist/bin.js rooms close <id>
```

The first runtime in `--agents` is the worker and edits files; every other one is a reviewer and runs
read-only. There is no limit of two.

### The loop

```
you post the task
   -> round 1: worker turn (permission: edits), engine captures the diff
   -> reviewer turns, in parallel (permission: read-only), each ending in a verdict
   -> all approve?  yes: commit the round on acr/<slug>, room = approved
                    no:  round 2 with the reviews, until max rounds, then room = needs-you
```

A `question` verdict stops the room immediately: it is addressed to you, so there is nobody else to
ask. A review with no verdict block counts as _not approved_ – `acr` never guesses an approval.

### Worktrees

Each room gets `~/.config/agent-chat-room/worktrees/<roomId>` on branch `acr/<slug>`, created from
the HEAD your checkout was on. That branch is what you merge or open a PR from; `acr rooms close`
removes the worktree and keeps the branch.

Pass `--no-worktree` to work in the checkout instead (useful with submodules or tooling that dislikes
worktrees). In that mode `acr` refuses to start on a dirty tree unless you also pass `--allow-dirty`,
because otherwise a room's diff is not attributable to the room.

Note that a fresh worktree has no `node_modules` and no build output. The worker is told to say so
rather than install the world; a setup hook is M3.

### `.acr.json`

Optional, committed at the repo root. CLI flags beat it, and it beats the built-in defaults:

```jsonc
{
  "agents": ["claude", "codex"], // the first one is the worker
  "rounds": 4,
  "worktree": true,
  "timeoutSeconds": 1800,
  "models": { "claude": "opus" },
  "permissions": { "worker": "edits" },
}
```

Unknown keys warn and are ignored, so a file written by a newer `acr` never bricks an older one.

### State on disk

```
~/.config/agent-chat-room/
  acr.db                  rooms, participants, messages, turns, recent repos (schema v1)
  turns/<turnId>.jsonl    every raw line a runtime emitted, for debugging an adapter
  worktrees/<roomId>/     the room's checkout
  diffs/<messageId>.diff  diffs too large to keep in a row
  locks/<hash>.lock       the advisory per-repo write lock
```

`ACR_CONFIG_DIR` moves all of it, which is how the tests keep it disposable.

Exit codes, so it is usable from a script:

| code | meaning                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------- |
| 0    | the reviewers approved                                                                         |
| 1    | acr or a runtime failed                                                                        |
| 2    | bad usage                                                                                      |
| 3    | the reviewers did not approve (`request-changes`, `question`, no verdict block, or max rounds) |

## Verdicts

Every reviewer message ends with a fenced block, which is what makes the loop deterministic instead
of grepping for "LGTM":

````
```verdict
{ "decision": "approve" | "request-changes" | "question", "blocking": ["..."], "nits": ["..."] }
```
````

The fence is the portable path and works for any runtime. `--json-schema` (Claude) and
`--output-schema` (Codex) are wired up as an optional extra, never as something the loop depends on.

## Development

```sh
npm run build       # tsc -b across the workspace
npm test            # vitest, hermetic: no network, no agent CLI required
npm run lint        # eslint, type-aware
npm run typecheck
npm run format
```

`npm test` never spawns an agent CLI. The adapter tests replay recorded fixtures
(`packages/core/test/fixtures/`), the process tests drive a tiny `node -e` child, and everything
above the adapter layer runs against the `echo` test-double adapter. Tests that touch the store or a
worktree point `ACR_CONFIG_DIR` at a throwaway directory.

The one test that talks to real CLIs is the M1 acceptance test, and it is opt in:

```sh
ACR_LIVE=1 npm test -- live
```

### Adding a runtime

Implement `AgentAdapter` from `packages/core/src/types.ts` – an id, `detect()`, `capabilities`, and
`run(req, sink)` – and register it in `packages/core/src/adapters/index.ts`. Two rules keep the rest
of the system honest:

- **Vendor flags only live in `permissions.ts`.** The engine speaks `read-only | edits | full`.
- **Never fail on an unknown event.** Runtimes add event types between releases; an adapter that
  throws on one breaks every room on the next upgrade.

`packages/core/src/process/runTurn.ts` is the only place in the project that spawns a process, so
adapters stay a pair of pure pieces: an argv builder and a stream parser. Likewise
`packages/core/src/store/rooms.ts` is the only place that holds SQL, so swapping `better-sqlite3`
for something else is one file rather than a refactor.

The engine emits the event stream M2's WebSocket will forward, unchanged:

```ts
type EngineEvent =
  | { type: 'room.state'; roomId: string; state: RoomState; round: number }
  | {
      type: 'message.start';
      roomId: string;
      messageId: string;
      author: string;
      role: string;
      round: number;
    }
  | { type: 'message.delta'; roomId: string; messageId: string; text: string }
  | { type: 'message.done'; roomId: string; message: Message }
  | { type: 'turn.activity'; roomId: string; turnId: string; event: TurnEvent };
```

The terminal renderer consumes exactly that, so the CLI and the browser end up being two views of one
loop rather than two implementations of it.

## License

MIT (LICENSE file lands with the public release in M4).
