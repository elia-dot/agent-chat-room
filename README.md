# agent-chat-room

Turn the "two terminals, one Claude, one Codex, ping-pong until it's done" workflow into a room:
you post a task, one agent builds, the others review, and they iterate until they agree or you
step in.

Every agent runs through the CLI you already have installed and logged in, so it works on your
existing subscriptions. **No API keys.** `acr` never reads your credentials – it only checks that
a credentials file exists, and lets each CLI find its own login the way it normally does.

The full design lives in [`docs/PLAN.md`](docs/PLAN.md).

## Status: milestone M2

M2 is "the web UI": a local server, a WebSocket, and a React app over the M1 room engine.
What works today:

- **`acr`** – with no arguments, starts the server on `http://127.0.0.1:4321` and opens the browser.
  Rooms list, live transcript, composer with `@mentions` and pause/continue, right panel with
  participants, changed files and a diff viewer, a new-room dialog and a doctor page.
- **Nothing listens on the network.** The server binds `127.0.0.1` only, _and_ refuses any request
  whose `Origin` is not a localhost one – otherwise any page open in your browser could drive it.
- **Interrupt any time.** Posting a message holds the loop and points the next turn at whoever you
  `@mention`; Continue picks the round loop back up.
- **macOS notifications** when a room reaches `approved` or `needs-you` (`ACR_NO_NOTIFY=1` to skip).
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

Not here yet (all M3): the Cursor adapter, brainstorm mode, swapping a participant's role or model
mid-room, the Commit / Open PR buttons, and markdown export. The right panel's roster is read-only.

## Try it

```sh
nvm use            # Node 22.14 (>= 20.19 works)
npm install
npm run build      # tsc -b for the packages, vite build for the web app

node packages/cli/dist/bin.js            # server + browser on http://127.0.0.1:4321
```

Port 4321 is the default; if it is taken `acr` walks upward and prints the URL it actually bound.
`acr serve --port N` pins one instead (and fails rather than moving), and `--no-open` leaves your
browser alone.

Rooms run inside that process. Closing the tab does not stop a room; Ctrl-C does.

### From the terminal instead

```sh
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

Driving one room from the browser and a terminal `acr run` at the same time is unsupported: the
per-repo write lock stops them corrupting the repo, but two engines over one room row would still
interleave state writes. A cross-process room lock is M3.

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
  acr.db                  rooms, participants, messages, turns, recent repos (schema v2)
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
npm run build       # tsc -b across the workspace, then vite build for the web app
npm test            # vitest, hermetic: no network, no agent CLI required
npm run lint        # eslint, type-aware
npm run typecheck
npm run format
```

Two terminals, for working on the UI:

```sh
npm run build:ts && npm run dev:server   # the API on :4321, no browser
npm run dev:web                          # Vite on :5173, proxying /api and the WebSocket
```

The server tests drive every route through `app.inject()` and never open a port, except the
WebSocket ones, which listen on port 0. The web tests run in `node`, not jsdom: everything worth
pinning – the event reducer, mention parsing, diff parsing – is a pure module, deliberately, so
there are no DOM component tests to need a browser environment.

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

The engine emits the event stream the WebSocket forwards, unchanged:

```ts
type EngineEvent =
  | { type: 'room.state'; roomId: string; state: RoomState; round: number }
  | { type: 'room.paused'; roomId: string; paused: boolean }
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

The terminal renderer consumes exactly that, and so does the WebSocket – `/api/ws` forwards these
values verbatim after one `snapshot` frame – so the CLI and the browser end up being two views of
one loop rather than two implementations of it.

### The HTTP surface

Everything is under `/api`, bound to `127.0.0.1`, and origin-checked:

| method + path                                                               | what it does                                                   |
| --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `GET /api/health`                                                           | `{ ok, version }`                                              |
| `GET /api/runtimes`                                                         | the same payload as `acr doctor --json`                        |
| `GET /api/rooms`                                                            | `?repo=&open=&limit=`                                          |
| `POST /api/rooms`                                                           | open a room; `start: true` kicks the loop off                  |
| `GET /api/rooms/:id`                                                        | room, roster, transcript, turns, and the in-flight turn buffer |
| `GET /api/rooms/:id/messages`                                               | `?afterSeq=&limit=` – the tail, not the history                |
| `GET /api/rooms/:id/diff?message=`                                          | `text/plain`, following a diff that spilled to disk            |
| `GET /api/rooms/:id/files`                                                  | changed files and `git diff --stat` against the room's base    |
| `POST /api/rooms/:id/messages`                                              | say something; holds the loop, sets the next speaker           |
| `POST /api/rooms/:id/start` \| `/pause` \| `/resume` \| `/stop` \| `/close` | drive the room                                                 |
| `PATCH /api/rooms/:id`                                                      | `{ maxRounds?, title? }`                                       |
| `GET /api/repos` \| `/api/repos/browse?path=`                               | the repo picker                                                |

`GET /api/repos/browse` reads directories and `POST /api/rooms` spawns an agent CLI with `edits`
permission, so the origin check is load-bearing rather than a nicety: without it, any page you have
open could POST to `127.0.0.1:4321`.

## License

MIT (LICENSE file lands with the public release in M4).
