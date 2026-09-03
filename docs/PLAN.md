# Agent Chat Room – Plan

A local app that turns the "two terminals, one Claude, one Codex, ping-pong until it's done"
workflow into a room: you post a task, one agent builds, the others review, and they iterate
until they agree or you step in. Every agent runs through the CLI you already have installed
and logged in, so it all works on your existing subscriptions. No API keys.

Status: private prototype on this machine. Target: public GitHub repo (MIT) that anyone can
install with `npx agent-chat-room` and use with whatever agents they have.

---

## 1. What exists on this machine today

| Runtime | Binary | Headless mode | Session resume | Read-only mode |
|---|---|---|---|---|
| Claude Code 2.1.x | `claude` | `claude -p --output-format stream-json --verbose` | `--resume <session_id>` | `--permission-mode plan` |
| Codex CLI 0.152 | `codex exec` | `codex exec --json` | `codex exec resume <thread_id>` | `-s read-only` |
| Cursor Agent 2026.07 | `cursor-agent` | `cursor-agent -p --output-format stream-json` | `--resume <chatId>` | `--mode ask` |

Verified event shapes (live probe, 2026-09-03):

- Claude: `system/init` (carries `session_id`), `assistant` (content blocks: text, tool_use),
  `user` (tool results), `result` (final text, usage, `session_id`). Global hooks from
  `~/.claude/settings.json` fire inside the headless run too, so the adapter must tolerate
  `system/hook_*` events.
- Codex: `thread.started` (`thread_id`), `turn.started`, `item.completed` with
  `item.type` in `agent_message | command_execution | file_change | reasoning`,
  `turn.completed` (usage).
- Cursor: `system/init` (carries `session_id`), `user` (our own prompt echoed back),
  `thinking` (`delta` / `completed`), `assistant` (Anthropic-style content blocks – one
  event per *text delta* with `--stream-partial-output`, not one per block), `tool_call`
  (`started` / `completed`, payload keyed by tool: `readToolCall`, `shellToolCall`,
  `globToolCall`, …, with a one-key result envelope `{ success | permissionDenied | … }`),
  `result` (final text, `is_error`, camelCase `usage`). Probed live 2026-09-03 and recorded
  in `packages/core/test/fixtures/cursor_run.jsonl`.

Toolchain: Node 22.14, npm 11. No bun/pnpm. Denly (`~/Desktop/coding-control-plane`) is the
reference for "spawn the user's CLI with their subscription login"; see section 9.

---

## 2. Core concepts

**Room** – one task on one repo, with a roster of participants and a mode. A room owns a
transcript, a branch (or worktree), and a state machine.

**Participant** – `{ runtime, role, permission, model? }`. Runtimes come from adapters
(claude, codex, cursor, ...). Roles in v1: `worker`, `reviewer`, `moderator` (brainstorm
mode only). You are always a participant with role `owner`.

**Turn** – one headless CLI run for one participant. A turn receives the room messages it
has not seen yet plus its role instructions, and produces one message (and possibly file
changes). Each participant keeps its own CLI session across turns via resume, so it
remembers the whole room without us re-sending the transcript every time.

**Message** – `{ id, roomId, author, role, round, kind, text, verdict?, activity[], diff? }`.
`kind` is `user | agent | system`. `activity` is the collapsed tool log (commands run, files
touched). `diff` is the git diff produced during that turn, captured by the engine.

**Verdict** – every reviewer message must end with a structured block:

```verdict
{ "decision": "approve" | "request-changes" | "question", "blocking": ["..."], "nits": ["..."] }
```

The engine parses it; Claude gets it via `--json-schema`, Codex via `--output-schema`, and
the fenced block is the portable fallback for any adapter.

---

## 3. The loop (mode: `build-review`)

```
you post task
   │
   ▼
round 1: WORKER turn (permission: edits)
   │  engine captures diff since round start, attaches to message
   ▼
REVIEWER turns, in parallel (permission: read-only)
   │  each posts review + verdict
   ▼
all approve? ──yes──► engine commits the round on acr/<slug> ► room = approved ► merge / open PR
   │ no
   ▼
round N+1: WORKER turn with the review comments
   (repeat until approve, max_rounds reached, or you step in)
```

Rules that keep it from spinning:

- **Single writer.** Only the worker may edit. Reviewers run with the runtime's read-only mode.
- **Max rounds** (default 4). On hitting it, the room goes to `needs-you` with the open points.
- **Reviewers must cite `file:line`** for every blocking item, and may not raise a new blocking
  item on a line the worker did not touch after round 2 (prevents moving goalposts).
- **You can interrupt any time.** A message from you pauses the auto loop; the next turn is
  whoever you @mention, or the worker by default. "Continue" resumes the policy.
- **Swap roles** between rounds ("make codex the worker now") without losing sessions.

Mode: `brainstorm` (v1.1)

1. All participants answer the prompt in parallel, read-only.
2. Each gets one turn to react to the others' answers.
3. The moderator writes a merged proposal. You accept it, or turn it into a `build-review`
   room with one click (the proposal becomes the task).

---

## 4. Architecture

```
packages/
  core/      adapters, room engine, prompt builder, verdict parser, git helpers, store
  server/    Fastify + WebSocket, serves the web build, owns the SQLite db
  web/       React + Vite + Tailwind, the chat UI
  cli/       `acr` binary: start the server, `run` in terminal, `doctor`
```

Single Node process: `acr` starts the server on `localhost:4321`, opens the browser, and
runs rooms in-process. Nothing listens on the network. State lives in
`~/.config/agent-chat-room/` (db + logs); per-repo defaults in an optional `.acr.json`.

### 4.1 Adapter interface (the part others will contribute)

```ts
export interface AgentAdapter {
  id: string;                       // 'claude' | 'codex' | 'cursor' | ...
  displayName: string;
  detect(): Promise<Detection>;     // { installed, version, loggedIn?, minVersionOk }
  capabilities: { resume: boolean; readOnly: boolean; structuredOutput: boolean; models?: string[] };
  run(req: TurnRequest, sink: EventSink): TurnHandle;   // spawn, stream, cancel
}

interface TurnRequest {
  cwd: string;
  prompt: string;
  sessionId?: string;               // resume if present
  permission: 'read-only' | 'edits' | 'full';
  model?: string;
  systemAppend?: string;            // role instructions
  outputSchema?: JsonSchema;        // verdict
  timeoutMs: number;
}

type TurnEvent =
  | { type: 'started'; sessionId: string }
  | { type: 'text'; text: string; final?: boolean }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'file'; path: string; op: 'edit' | 'create' | 'delete' }
  | { type: 'done'; text: string; usage?: Usage; structured?: unknown }
  | { type: 'error'; message: string; exitCode?: number };
```

Concrete command lines:

```sh
# claude
claude -p --output-format stream-json --verbose \
  --permission-mode <plan|acceptEdits|bypassPermissions> \
  [--resume <id>] [--model <m>] [--append-system-prompt <role>] [--json-schema <verdict>]
# prompt on stdin

# codex
codex exec --json -C <cwd> -s <read-only|workspace-write|danger-full-access> \
  [-m <m>] [--output-schema verdict.json] [-o last.txt]
codex exec resume <thread_id> --json ...          # later turns
# prompt on stdin

# cursor
cursor-agent -p --output-format stream-json --stream-partial-output --workspace <cwd> \
  [--mode ask --sandbox enabled] [--force] [--trust] [--resume <chatId>] [--model <m>]
# prompt on stdin (probed: `-p` with no positional argument reads stdin)
```

Permission mapping (the only place vendor flags leak in):

| acr permission | claude | codex | cursor |
|---|---|---|---|
| read-only | `--permission-mode plan --tools Read,Glob,Grep` | `-s read-only` | `--mode ask --sandbox enabled --trust` |
| edits (default worker) | `--permission-mode acceptEdits` | `-s workspace-write` | `--trust` |
| full (explicit opt-in) | `--permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` | `--force --trust` |

Cursor's read-only row was verified rather than assumed (2026-09-03): a turn in `--mode ask`
asked to create a file answers "Ask mode is active … writing would be an edit" and creates
nothing, and even a read-only shell call comes back `permissionDenied`. `--trust` is on every
row because a headless turn has nobody to answer the "trust this workspace?" prompt.

### 4.2 Room engine

A small state machine per room: `idle → running(turn) → waiting-reviews → needs-you | approved | stopped`.
It runs turns through a queue with a per-repo write lock. Every raw CLI event is appended
to `turns/<turnId>.jsonl` for debugging; the parsed message goes into SQLite and is pushed
over the WebSocket as it streams.

Prompt builder, per turn:

```
You are <runtime> acting as <ROLE> in room "<title>" (round <n>).
Repo: <cwd> on branch <branch>.

## Task
<task text>

## New messages since your last turn
[elia] ...
[codex · reviewer · round 1] ... (verdict: request-changes)

## Changes in this room so far
<git diff --stat base..HEAD>   (full diff inline if < 60 KB, else "run git diff base..HEAD")

## Your job now
<role instructions>  e.g. reviewer: "Do not edit files. Cite file:line. End with a verdict block."
```

Git helpers: every room runs in its own git worktree at `~/.config/agent-chat-room/worktrees/<room>`
on branch `acr/<room-slug>`, created from the current HEAD when the room opens. `base` is
that commit. Diff capture = `git diff base` plus untracked files, taken right after the
worker's turn. When all reviewers approve a round, the engine commits the round on the room
branch with a generated message (the worker's summary as the body) and posts the commit
hash to the room. The right panel offers "Merge into <current branch>" and "Open PR" for
the final result; the worktree is removed when the room is closed.

### 4.3 Store

SQLite via `better-sqlite3`. Tables: `rooms`, `participants`, `messages`, `turns`,
`repos` (recent). Migrations as numbered SQL files. Export a room as markdown.

### 4.4 Server

Fastify on localhost only. REST for CRUD (`/rooms`, `/rooms/:id/messages`, `/runtimes`,
`/repos/browse`), one WebSocket per client for streaming events (`message.delta`,
`message.done`, `room.state`, `turn.activity`). Serves `packages/web/dist`.

---

## 5. UI

Web app, chat layout (Slack-like, three columns). Dark and light.

```
┌──────────────┬──────────────────────────────────────────────┬───────────────────────┐
│ ROOMS        │ # fix-flaky-login-test          ● round 2/4  │ ROOM                  │
│              │──────────────────────────────────────────────│ repo  ~/Denly/travelog │
│ ● flaky-login│ [you]  Fix the flaky login test, it fails    │ branch acr/flaky-login │
│ ○ pricing-ui │        every ~5th run on CI...               │ mode  build-review     │
│ ✓ auth-refac │                                              │                        │
│              │ [claude · worker · r1]                       │ PARTICIPANTS           │
│ + New room   │  Root cause: the test asserts before the     │ ◆ claude  worker  edits│
│              │  redirect settles. Added waitFor...          │ ◆ codex   reviewer ro  │
│              │  ▸ activity (7 tool calls)  ▸ diff +12 −3    │ ◆ cursor  reviewer ro  │
│              │                                              │ ◆ you     owner        │
│              │ [codex · reviewer · r1]   REQUEST CHANGES    │                        │
│              │  Blocking: tests/login.spec.ts:41 the        │ CHANGED FILES          │
│              │  waitFor timeout is 500ms, CI is slower...   │ M tests/login.spec.ts  │
│              │                                              │ M src/auth/redirect.ts │
│              │ [cursor · reviewer · r1]  APPROVE            │                        │
│              │  Looks right. Nit: name the constant.        │ USAGE                  │
│              │                                              │ 4 turns · 2m 10s       │
│              │ ── system: round 2, claude addressing 1 ──   │                        │
│              │ [claude · worker · r2]  ▍ streaming...       │ [Pause] [Stop]         │
│              │──────────────────────────────────────────────│ [Commit] [Open PR]     │
│              │ Message the room… @codex @claude    [Send]   │                        │
└──────────────┴──────────────────────────────────────────────┴───────────────────────┘
```

Screens:

1. **Rooms sidebar.** Status dot: running (pulsing), needs-you (amber), approved (green),
   stopped (grey). Unread badge. Filter by repo.
2. **Transcript.** One bubble per message. Author avatar colored per runtime (Claude
   orange, Codex green, Cursor blue, you neutral), role chip, round chip. Verdict pill on
   reviewer messages. Two collapsible drawers under agent messages: *activity* (tool calls,
   commands, in order) and *diff* (opens the diff viewer in the right panel or a modal).
   System lines for round boundaries, approvals count ("2 of 2 approved"), pauses, errors.
   Streaming text renders live; markdown with code blocks.
3. **Composer.** Textarea, `@runtime` mentions (autocomplete), Enter to send. Sending pauses
   the auto loop and routes the next turn to the mention (or the worker). Buttons:
   Pause / Continue, Stop, "Next: choose who speaks". Slash commands: `/role codex worker`,
   `/rounds 6`, `/mode brainstorm`.
4. **Right panel.** Repo + branch, mode, round counter, participants with role dropdown,
   permission chip and model picker, changed-files tree with a side-by-side diff viewer,
   usage (turns, wall time, tokens if the CLI reports them), actions (Commit with a
   generated message, Open PR via `gh`, Export markdown).
5. **New room dialog.** Repo picker (recent + browse), task textarea, mode, roster: every
   detected runtime as a toggle card (with version and login status), drag to order (first
   is the worker), role and permission per card, options (max rounds, worktree, auto-commit
   on approve).
6. **Settings / Doctor.** Detected runtimes with version and login state, default models,
   default permissions, port, notifications toggle. Same output as `acr doctor`.
7. **Notifications.** macOS notification when a room reaches `needs-you` or `approved`
   (via `osascript`, later `node-notifier` for cross-platform). Tab title shows counts.

CLI fallback for the same engine, useful for scripting and for people who never open the UI:

```sh
acr                              # start server + open UI
acr doctor                       # which runtimes are installed / logged in
acr run --task "..." --agents claude,codex --rounds 3   # stream a room to the terminal
acr rooms ls | acr rooms open <id>
```

---

## 6. Milestones

**M0 – Prove the loop (terminal only).** Scaffold monorepo (TS, npm workspaces, vitest,
eslint). Claude + Codex adapters with `detect()` and streaming `run()`. `acr doctor`.
`acr run` that does one worker turn then one reviewer turn on a real repo and prints both.
Done when: it fixes something in a sample repo and Codex's review parses into a verdict.

**M1 – Room engine.** SQLite store, state machine, rounds, verdict loop, session resume,
diff capture, write lock, max rounds, worktree option, JSONL turn logs, `.acr.json`.
Done when: `acr run` completes a full approve cycle unattended and can be resumed after
the process restarts.

**M2 – Web UI.** Server + WebSocket, React app: rooms list, transcript with streaming,
composer with mentions and pause/continue, right panel with participants and diff viewer,
new-room dialog, doctor page. macOS notifications.
Done when: you run a real task end to end from the browser without touching the terminal.

**M3 – More runtimes and modes.** Cursor adapter, brainstorm mode, role swapping mid-room,
commit / open PR actions, markdown export, model picker per participant.

**M4 – Public release.** README with a 30-second GIF, MIT LICENSE, `npx agent-chat-room`,
`CONTRIBUTING.md` with the adapter guide and a fake "echo" adapter for tests, GitHub
Actions (lint, test, build), adapter contract tests against pinned CLI versions,
cross-platform spawn (Windows paths, `shell: false`), issue templates.

Suggested order of work for M0 this week: adapters first, engine second, UI last. The UI is
the least risky part; the streaming/resume/permission behaviour of the CLIs is where the
surprises are.

---

## 7. Decisions already made (and why)

- **Spawn the vendor CLIs, never call model APIs.** That is what makes it run on
  subscriptions and keeps the project out of the credentials business entirely.
- **TypeScript everywhere.** One language for adapters, engine, and UI lowers the bar for
  contributors, and Node is what the target users already have for these CLIs.
- **Session resume instead of re-sending transcripts.** Cheaper, and each agent keeps its
  own working memory of the repo across rounds.
- **Structured verdicts.** Free-text "LGTM" detection is brittle. A schema makes the loop
  deterministic and gives the UI a real state to show.
- **Conservative permissions by default.** Worker = edits, reviewers = read-only, `full`
  only by explicit per-room opt-in with a warning. Public users will run this on real repos.
- **Local only.** No network listener, no telemetry, no accounts. Public trust depends on it.
- **Name stays `agent-chat-room`, binary `acr`.** Decided 2026-09-03.
- **Every room runs in a git worktree.** Your checkout stays untouched; the room branch
  `acr/<slug>` is what you merge or open a PR from. Decided 2026-09-03.
- **The engine commits after each approved round.** Round history lands as commits on the
  room branch, so a room's work is never sitting only in a working tree. Decided 2026-09-03.

## 8. Risks and how the plan handles them

| Risk | Mitigation |
|---|---|
| CLI output formats change between versions | Adapters declare a min version; `doctor` warns; contract tests per adapter with recorded fixtures |
| Reviewers rubber-stamp or nitpick forever | Verdict schema, `file:line` rule, no new blockers after round 2, max rounds, optional "skeptic" reviewer instructions |
| Two agents editing at once | Write lock; reviewers read-only; worktree option |
| Runaway usage against subscription caps | Per-room turn/time counters visible in UI; max rounds; pause on error |
| User's global hooks/settings interfere (seen: Claude SessionStart hook) | Default to `--setting-sources project` for Claude and `--ignore-user-config` for Codex, with a per-room override |
| Long turns look hung | Stream activity events; per-turn timeout with "still running" heartbeat |

## 9. Reuse from Denly

Denly's runner (`~/Desktop/coding-control-plane/pipeline/runtime_cli.py`, Python asyncio)
already solves the hard half of this project. What to carry over, and what not to:

**Carry over the shape.** Denly's `CliSpec(id, argv, parse_line, parse_text, env, buffered,
inspect_supported)` is exactly the adapter interface in 4.1, and it has five working entries
(claude, codex, cursor, grok, agy). Port the argv builders and parsers to TypeScript
one-to-one; they are the distilled result of a lot of trial and error:

- One subprocess per turn, `stdin` closed, prompt passed as an argument; session id is read
  from the first event and threaded into the next turn's resume flag. (This plan passes the
  prompt on stdin instead, because room transcripts can exceed comfortable argv sizes.)
- Turn done = child exits. No in-band "done" event is needed. Keep the same guards: a
  per-read stall timeout (Denly uses 1800 s), a 30 s exit grace, kill in `finally`, and a
  concurrent stderr drain so the pipe never deadlocks.
- No env injection at all. Each CLI finds its own login on disk or in the keychain. That is
  the entire subscription mechanism, and it is what keeps us out of credential handling.
- Detection = `which(binary)` plus a presence-only auth probe (`~/.codex/auth.json`,
  `~/.gemini/oauth_creds.json`, Cursor keychain) that never reads key material and never
  spawns the CLI. Reuse this for `acr doctor`.
- Codex and Cursor have no system-prompt flag, so role instructions get prepended to the
  first turn's prompt; Claude gets `--append-system-prompt`.
- Golden fixtures `tests/fixtures/codex_run.jsonl` and `cursor_run.jsonl` are worth copying
  in as adapter contract tests.

**Do differently.** Denly's UI polls REST; this project streams over a WebSocket because a
chat room is all about watching turns as they happen. Denly is a control plane with a cloud
backend; this project is local only and single process.

**License caveat.** Denly has no LICENSE file and its README says "all rights reserved
pending a license decision". Since you own it, either add a note relicensing the two files
you port, or write the TypeScript adapters as a clean port (same command lines, fresh code)
so the public MIT repo has no ancestry question. The second option is simpler.

## 10. Resolved questions

All three open questions were answered on 2026-09-03 and folded into section 7:
name stays `agent-chat-room`, rooms always run in a git worktree, and the engine commits
after each approved round.

M3 decisions, 2026-09-03:

- **Cursor takes its prompt on stdin**, not as the trailing positional argument its `--help`
  documents. Probed: `cursor-agent -p` with no positional reads stdin and answers normally.
  That matters because section 9's reason for stdin – room transcripts can exceed a
  comfortable argv size – applies to Cursor exactly as it does to Claude and Codex.
- **A brainstorm room is three fixed rounds**, mapped onto the existing round counter:
  answer, react, merge. Nothing about the store, the state machine or the WebSocket had to
  change, and the room ends in `needs-you` holding a proposal. For that mode `needs-you` is
  success, so the sidebar says "proposed" and `acr run` exits 0.
- **A role swap keeps sessions**, which is what section 3 asks for. The cost is that the
  swapped agent's session still remembers being the other role; the engine re-announces the
  new role in the next prompt, because Codex and Cursor only see role instructions on a
  session's first turn.
- **Merge is not in M3.** Section 4.2 sketches "Merge into `<current branch>`" beside "Open
  PR"; section 6 lists only commit and open-PR, and merging writes to the branch the human
  is standing on, which the worktree design has carefully avoided. Deferred to M4.
- **`gh` is an optional dependency.** "Open PR" shells out to the GitHub CLI rather than
  asking for a token, which keeps section 7's promise. Present and the button works, absent
  and it explains itself. Nothing pushes without an explicit press.
- **A room now takes a cross-process lock** for the whole loop, so `acr run --room X` against
  a room the server is driving fails fast instead of interleaving state writes.
