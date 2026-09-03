# Adapter fixtures

Recorded output from the real CLIs, used as contract tests. PLAN.md section 8 names these as
the mitigation for "CLI output formats change between versions": when a runtime changes its
event shapes, one of these tests fails instead of a room silently going quiet.

| File | Recorded from | Version | Command |
|---|---|---|---|
| `claude_run.jsonl` | Claude Code | 2.1.259 | `claude -p --output-format stream-json --verbose --setting-sources project --permission-mode plan --tools Read,Glob,Grep` |
| `codex_run.jsonl` | Codex CLI | 0.152.1 | `codex exec --json -C <dir> -s read-only --skip-git-repo-check --ignore-user-config` |
| `codex_failed.jsonl` | Codex CLI | 0.152.1 | same, plus `-m no-such-model-xyz` to force a real `turn.failed` |
| `cursor_run.jsonl` | Cursor Agent | 2026.07.23 | `cursor-agent -p --output-format stream-json --stream-partial-output --mode ask --sandbox enabled --trust` |
| `claude_noise.jsonl` | hand written | - | events an adapter must survive rather than parse |

All of them come from a throwaway repo containing a single `math.js` whose `add()` subtracts.
`claude_noise.jsonl` is the one file here that is *not* a recording: it exists to pin the
tolerance rules (unknown `system` subtypes, unknown top-level types, a non-JSON log line)
that are hard to provoke on demand but show up on other people's machines.

`cursor_run.jsonl` is the reviewer half of the same exercise, recorded live on 2026-09-03. It is
worth reading for two things `--help` cannot tell you: Cursor streams one `assistant` event per
text delta rather than one per block, and the shell call in it comes back `permissionDenied`,
which is the recorded proof that `--mode ask` refuses more than a mode name suggests.

The `system/init` event in `claude_run.jsonl` has had the recording machine's tool list, MCP
servers, skills and home path replaced with neutral values. `cursor_run.jsonl` has had its
session id, request id and recording path replaced the same way. Nothing a parser looks at was
touched; the point is that a fixture should not publish whatever the person who recorded it
happened to have connected.

To re-record, run the command in the table with stdout redirected to the file, scrub the init
event the same way, and note the new version here.
