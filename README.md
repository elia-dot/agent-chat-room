# agent-chat-room

Turn the "two terminals, one Claude, one Codex, ping-pong until it's done" workflow into a room:
you post a task, one agent builds, the others review, and they iterate until they agree or you
step in.

Every agent runs through the CLI you already have installed and logged in, so it works on your
existing subscriptions. **No API keys.** `acr` never reads your credentials – it only checks that
a credentials file exists, and lets each CLI find its own login the way it normally does.

The full design lives in [`docs/PLAN.md`](docs/PLAN.md).

## Status: milestone M0

M0 is "prove the loop, terminal only". What works today:

- **Adapters** for Claude Code and Codex CLI: `detect()`, argv building, streaming `run()`, session
  resume, and a permission model with exactly three levels (`read-only`, `edits`, `full`).
- **`acr doctor`** – which runtimes are installed, new enough and logged in.
- **`acr run`** – one worker turn, then one reviewer turn on a real repo, both streamed to the
  terminal, with the worker's diff attached to the reviewer's prompt and the review parsed into a
  structured verdict.

Not here yet: the round loop, the SQLite store, worktrees, auto-commit, the server, and the web UI.
Those are M1–M3 in the plan.

## Try it

```sh
nvm use            # Node 22.14 (>= 20.19 works)
npm install
npm run build

node packages/cli/dist/bin.js doctor
node packages/cli/dist/bin.js run \
  --task "The login test is flaky. Find out why and fix it." \
  --agents claude,codex \
  --cwd ~/code/your-repo
```

The first runtime in `--agents` is the worker and edits files; the second is the reviewer and runs
read-only. M0 has no worktree yet, so `acr run` works in the checkout you point it at and refuses to
start on a dirty tree unless you pass `--allow-dirty`.

Exit codes, so it is usable from a script:

| code | meaning                                                                           |
| ---- | --------------------------------------------------------------------------------- |
| 0    | the reviewer approved                                                             |
| 1    | acr or a runtime failed                                                           |
| 2    | bad usage                                                                         |
| 3    | the reviewer did not approve (`request-changes`, `question`, or no verdict block) |

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
above the adapter layer runs against the `echo` test-double adapter.

The one test that talks to real CLIs is the M0 acceptance test, and it is opt in:

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
adapters stay a pair of pure pieces: an argv builder and a stream parser.

## License

MIT (LICENSE file lands with the public release in M4).
