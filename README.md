# agent-chat-room

A local web app and CLI where your installed coding agents build and review code together.
Post a task, choose a worker and reviewers, and follow their conversation, tool activity and
diffs. The worker edits; reviewers give structured verdicts; the loop continues until they
approve, need your input, or you stop it. A separate brainstorm mode produces a shared proposal.

<a href="https://denly.dev"><img src="https://raw.githubusercontent.com/elia-dot/agent-chat-room/main/packages/web/public/denly-logo.png" alt="Denly logo" width="48" height="48"></a>

Built with the help of [Denly](https://denly.dev).

## Requirements

- **Node.js >= 20.19**, npm, and Git on your `PATH`.
- A local Git repository with at least one commit and a configured Git author identity
  (`git config user.name` and `git config user.email`) for room commits.
- Installed, authenticated agent CLIs. A room needs at least two participants; they may use
  the same runtime. The terminal default is `claude,codex`.
- Optional: an authenticated GitHub CLI (`gh`) and permission to push for **Open PR**.

ACR uses each agent CLI's existing authentication; it does not ask you to configure API keys
in ACR. Provider accounts, billing, model access and usage limits still apply. Login detection
checks for credential files, not whether your session is valid or has quota.

| Agent        | ID for `--agents` | Executable     | Minimum version checked by ACR |
| ------------ | ----------------- | -------------- | ------------------------------ |
| Claude Code  | `claude`          | `claude`       | 2.0.0                          |
| Codex CLI    | `codex`           | `codex`        | 0.150.0                        |
| Cursor Agent | `cursor`          | `cursor-agent` | 2026.7.0                       |
| Antigravity  | `antigravity`     | `agy`          | 1.1.0                          |
| opencode     | `opencode`        | `opencode`     | 1.18.0                         |

These are adapter detection thresholds, not a guarantee that every later CLI version behaves
identically. Run `acr doctor` to check your installation. `echo` is a test adapter, not an AI agent.
CI covers macOS and Linux; Windows has platform-specific support but is not in the CI matrix.

## Install and start

Once the package is published to npm:

```sh
npx agent-chat-room
```

Or install the command globally:

```sh
npm install -g agent-chat-room
acr
```

To run this checkout, including before the first npm release:

```sh
git clone https://github.com/elia-dot/agent-chat-room.git
cd agent-chat-room
nvm use                 # optional: uses the Node version in .nvmrc
npm ci
npm run build
npm run acr -- doctor
npm run serve
```

For a source checkout, replace `acr` in the examples below with `npm run acr --`.
`better-sqlite3` is a native dependency: if no prebuilt binary is available for your Node/OS
combination, installation requires a working native build toolchain.

`acr` starts the server and opens your browser. It binds only `127.0.0.1`, starting at port
4321 and trying higher ports if needed. Use the full URL printed in the terminal: it includes
a token that authorizes the browser session. Keep that URL private.

```sh
acr serve --port 4321 --no-open
```

An explicit port fails if occupied. Closing the browser tab leaves rooms running; stopping
the server with Ctrl-C stops its active turns. Room history persists across restarts.

## Your first room

1. Open **rooms**, then **new room**, and choose a local repository.
2. Choose **build-review** to change code or **brainstorm** to discuss an approach.
3. Enter a task with the intended behavior and how to verify it. Choose at least two agents,
   their roles and optionally models. Use **doctor** if a runtime is unavailable.
4. Keep **Work in an isolated git worktree** enabled for a separate checkout. Fresh worktrees
   have no ignored dependencies or build artifacts; configure setup below if the project needs them.
5. Create the room and watch the transcript. Use the composer to send instructions or
   `@mention` a participant. **Pause** holds the work; **Continue** resumes the round loop.
6. Inspect the changed files and diff in the room panel. Use **actions** to commit unfinished
   work, merge locally, open a PR, or export the conversation.

Messages can interrupt active work and steer the next turn. A message to the worker in a
finished room that produces no changes can finish without another review; Continue requests
a full round. Between turns you can change models, swap the worker, or replace a runtime.
Changing a model or role keeps its session; replacing a runtime starts a new session.
The model picker includes **Custom…** for identifiers missing from its catalog.

Attach files with the paperclip, drag and drop, or paste a screenshot. Agents receive local
file paths to inspect. Type `#` to attach a snapshot of another room's transcript; it is not a
live reference. Exports and attachments can contain source code and private conversation data.

## Terminal usage

```sh
acr doctor
acr doctor --models       # model discovery may contact the provider
acr run --cwd ~/code/my-repo \
  --task "Find and fix the flaky login test, then run its test suite." \
  --agents claude,codex --model claude=opus

acr run --cwd ~/code/my-repo --mode brainstorm \
  --task "How should we restructure the pricing module?" \
  --agents claude,codex,cursor

acr rooms ls
acr rooms show <id>
acr rooms resume <id>
acr rooms export <id> --out room.md
acr rooms merge <id>
acr rooms close <id>
acr rooms purge <id>
acr data-path
acr --help
```

`--task-file path` reads a task from disk (`-` reads stdin). `--json` on `run` emits a JSON
summary. `--room <id>` resumes a room. `--timeout <seconds>` sets the per-read stall timeout
(default 1800 seconds), and `--retries <n>` retries failed turns up to 0–10 times (default 0).
A turn you stop is not automatically retried. After a failure, fix the cause and Continue or
resume to retry the interrupted round with the saved runtime session.

### How the modes finish

- **Build-review:** the first agent is the worker; the rest review in parallel. All reviewers
  must approve before the engine commits the approved work on the room branch. A question
  or failure hands the room back to you (`needs-you`). There is no round limit, so monitor
  usage and pause or stop when needed. Agent approval does not replace your own review.
- **Brainstorm:** everyone answers, everyone reacts, then the last agent (moderator) merges
  the discussion into a proposal. The three phases use read-only permissions by default.
  A finished proposal is shown as **proposed** (`needs-you` internally). **Promote** creates
  a new build-review room from it, with the moderator as worker.

For `acr run`, exit codes are `0` for approval or a completed brainstorm proposal, `1` for
runtime/internal failure, `2` for invalid usage, and `3` for a question or stopped/unapproved run.

## Git behavior and additional folders

Both the browser and CLI default to a branch named `acr/<slug>` in
`~/.config/agent-chat-room/worktrees/<roomId>`. Rooms start from the detected base branch:
local `origin/HEAD` metadata, then local `main` or `master`, then the current branch as fallback.
ACR fetches the base from `origin` when configured, preserves local commits ahead of it, and
refuses divergent histories or a failed fetch. It does not start from an arbitrary feature
branch just because that branch is checked out.

Providing a title determines the branch slug locally. Without one, ACR may ask an agent to
name it; set `ACR_NO_AUTO_BRANCH_NAME=1` to skip that extra turn.

`--no-worktree` (or disabling isolation in the dialog) switches your checkout to a new room
branch and edits there. A dirty checkout is refused unless you explicitly pass `--allow-dirty`;
that option can include existing changes in room commits.

- **Commit** stages and commits room changes on demand; approval also triggers a commit.
- **Merge** merges the room branch into its recorded base branch in your original checkout.
  That checkout must be clean, on the base branch, and free of an in-progress Git operation.
  A conflicting merge started by ACR is aborted.
- **Open PR** explicitly pushes the room branch and calls `gh pr create`. It can also open
  PRs for writable additional repositories. It requires your own Git/`gh` authentication.
- **Close** removes the room worktree and keeps its branch and history. Save or commit work
  before closing. **Purge** additionally deletes database records, turn logs and spilled diffs;
  it is not a secure erase of all copies, and currently does not remove attachment files.

Additional folders are accessed in place, not isolated worktrees. `read` folders are context
and edits there are reverted at the end of a turn. `write` folders join the room's diff and
commits; ACR branches those repositories and may include pre-existing uncommitted changes.
Merge operates on the primary repository only; merge additional repositories yourself.

## Repository configuration

Commit an optional `.acr.json` at the repository root. This is strict JSON (no comments or
trailing commas). For an npm project with a lockfile, for example:

```json
{
  "agents": ["claude", "codex"],
  "worktree": true,
  "timeoutSeconds": 1800,
  "models": { "claude": "opus" },
  "permissions": { "worker": "edits", "reviewer": "read-only" },
  "setup": ["npm ci", "npm run build"],
  "testCommand": "npm test",
  "maxTurnRetries": 0,
  "userConfig": true
}
```

Adapt or omit setup and test commands for your project. Setup runs before agent turns in an
isolated worktree and is skipped once all steps have succeeded. A failed setup stops for your
input; retrying can rerun earlier steps. `testCommand` runs between worker and reviewer turns
and its results are included for review. These commands execute in your local shell outside
agent permission controls; only use repository hooks you trust.

Explicit CLI/API options override repository defaults, which override built-in defaults.
The browser supplies its selected form values explicitly. Unknown keys and invalid fields
warn and are ignored. Optional `additional_dirs` takes objects such as
`{ "path": "/absolute/path/to/library", "access": "read" }`; a bare path string means **write**.

### Permissions and user configuration

Workers default to `edits`, reviewers to `read-only`. Permissions map to each vendor's flags
or configuration; they are not a uniform operating-system sandbox. In particular, denying
opencode's `webfetch` tool does not block networking through an allowed shell command.
Antigravity's `edits` mode cannot run shell commands, so a worker needing tests requires `full`.
`full` bypasses the runtime's permission checks, including protection of files outside the
workspace. Review the mappings in
[`permissions.ts`](https://github.com/elia-dot/agent-chat-room/blob/main/packages/core/src/permissions.ts).

`userConfig` defaults to `true`, loading the runtime's own skills, plugins, MCP servers and
instructions. Sandboxed Claude/Codex turns suppress hooks separately. Setting it to `false`
is best-effort configuration narrowing, not a security boundary:

| Runtime             | Effect of `userConfig: false`                                      |
| ------------------- | ------------------------------------------------------------------ |
| Claude              | Uses project setting sources only                                  |
| Codex               | Ignores user `config.toml`; local skills may still load            |
| opencode            | Uses `--pure` to omit external plugins; configuration still merges |
| Cursor, Antigravity | No user-configuration isolation flag is applied                    |

## Local data and troubleshooting

`acr data-path` prints the data directory, normally `~/.config/agent-chat-room`.
`ACR_CONFIG_DIR` overrides it. It contains `acr.db` (rooms, messages, participants and turns),
`server.token`, worktrees, raw runtime logs in `turns/`, spilled `diffs/`, `attachments/`,
and lock files. Back it up along with room branches if you need to keep the work.
Set `ACR_NO_NOTIFY=1` to disable macOS room notifications.

The server is local, but agent requests go to their providers, Git can contact remotes, and
configured tools/hooks can use the network. The UI also requests Google Fonts, with system
font fallbacks. This is not an offline service or a hosted multi-user server.
All API routes except `/api/health`, plus WebSocket connections, require the capability
token through a session cookie or `Authorization: Bearer <token>`. See
[SECURITY.md](https://github.com/elia-dot/agent-chat-room/blob/main/SECURITY.md).

| Problem                            | What to check                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Runtime missing or unusable        | Install/login through that CLI, ensure it is on the server process's `PATH`, then run `acr doctor`.                  |
| Authentication/model/quota error   | Run that CLI directly to verify its account and model access; change the room's model or runtime before retrying.    |
| Missing dependencies in a room     | Configure `setup` or prepare the displayed worktree yourself; your original checkout's ignored files are not copied. |
| Cannot update the base branch      | Check Git credentials, network access, and local/remote divergence before retrying.                                  |
| Browser unauthorized/disconnected  | Open the full token-bearing URL printed by the running server; verify that process is still running.                 |
| Port occupied                      | Use the URL ACR actually prints, or pick a free explicit `--port`.                                                   |
| Native SQLite install/load failure | Check Node compatibility and native build tools; rebuild dependencies for the Node version you are running.          |

## Development and contributions

Issues and pull requests are welcome:
[report a bug or request a feature](https://github.com/elia-dot/agent-chat-room/issues), or
read [CONTRIBUTING.md](https://github.com/elia-dot/agent-chat-room/blob/main/CONTRIBUTING.md)
for the contribution and adapter guide.

```sh
npm ci
npm run build
npm test
npm run typecheck
npm run lint
npm run format:check
```

For UI development, run the built API on port 4321 in one terminal and Vite in another:

```sh
npm run acr -- serve --port 4321 --no-open
npm run dev:web                           # open http://localhost:5173
```

Rebuild TypeScript after changing core/server/CLI code. Vite reloads web source changes.
The default tests use fixtures and the `echo` adapter; they do not invoke real agent CLIs.
Some server tests bind temporary loopback ports. Live acceptance tests are opt-in:
`ACR_LIVE=1 npm test -- live` (requires authenticated CLIs and can consume provider usage).

Maintainers: see the [release checklist](https://github.com/elia-dot/agent-chat-room/blob/main/docs/RELEASING.md)
for public GitHub settings, package inspection and npm publishing. The
[design plan](https://github.com/elia-dot/agent-chat-room/blob/main/docs/PLAN.md) is historical
context; [token efficiency](https://github.com/elia-dot/agent-chat-room/blob/main/docs/TOKEN_EFFICIENCY.md)
describes prompt and review behavior in more detail.

## License

[MIT](LICENSE). See [NOTICE](NOTICE) for attribution.
