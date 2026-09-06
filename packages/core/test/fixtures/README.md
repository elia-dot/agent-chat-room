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
| `agy_run.jsonl` | Antigravity | 1.1.26 | `agy --output-format stream-json --input-format stream-json --disable-slash-commands --add-dir <dir> --print-timeout 300s --sandbox -p=` |
| `agy_failed.jsonl` | Antigravity | 1.1.26 | same, plus `--model no-such-model-xyz` to force a real `ERROR` result |
| `opencode_run.jsonl` | opencode | 1.18.20 | `opencode run --format json --auto -m opencode/mimo-v2.5-free`, with `OPENCODE_CONFIG_CONTENT={"permission":{"edit":"deny","bash":"deny","webfetch":"deny"}}` |
| `opencode_failed.jsonl` | opencode | 1.18.20 | same, plus `-m opencode/does-not-exist-xyz` to force a real `error` event |
| `claude_noise.jsonl` | hand written | - | events an adapter must survive rather than parse |

All of them come from a throwaway repo containing a single `math.js` whose `add()` subtracts.
`claude_noise.jsonl` is the one file here that is *not* a recording: it exists to pin the
tolerance rules (unknown `system` subtypes, unknown top-level types, a non-JSON log line)
that are hard to provoke on demand but show up on other people's machines.

`cursor_run.jsonl` is the reviewer half of the same exercise, recorded live on 2026-09-03. It is
worth reading for two things `--help` cannot tell you: Cursor streams one `assistant` event per
text delta rather than one per block, and the shell call in it comes back `permissionDenied`,
which is the recorded proof that `--mode ask` refuses more than a mode name suggests.

`agy_run.jsonl` is the same reviewer exercise again, recorded live on 2026-09-04. It is the only
fixture here whose envelope has no top-level `type`: Antigravity keys events by `event`, and
everything interesting arrives as a `step_update` whose `step_type` says what it is. Two details
in it are worth reading before touching the parser – the closing `DONE` of an `agent_response`
step carries a `text_delta` too (so deltas have to be taken from both states to reassemble the
message), and `result.usage` is cumulative for the whole run rather than for the last step.

`opencode_run.jsonl` is the reviewer exercise once more, recorded live on 2026-09-06. Three things
in it are worth reading before touching the parser. It is the only fixture whose events all carry a
top-level `sessionID`, so the session is known from the first line rather than from an init event.
Its `text` events are whole message parts rather than deltas – a separate probe that asked for the
numbers 1 to 10 produced one event holding all ten lines – so the parser joins parts rather than
concatenating characters. And `step_finish.part.tokens` is per step, not cumulative, which is why
usage is added up across the three steps instead of read from the last one.

The denied `bash` call in it is the recorded proof that `permission: deny` withholds a tool rather
than refusing it: opencode reports the attempt as a synthetic tool named `invalid` whose `input`
names the tool it wanted. It was recorded with `--auto` *and* the denials in place, which is the
evidence that `--auto` cannot override a `deny`.

`opencode_failed.jsonl` is the one recording here that documents a limitation rather than a shape:
opencode answers an unusable model with a generic `UnknownError` / "Unexpected server error",
indistinguishable from a gateway outage, so `modelHint.ts` cannot tell the user their `-m` was the
problem. If a future release names the model, the test pinning that silence fails and tells us.

The `system/init` event in `claude_run.jsonl` has had the recording machine's tool list, MCP
servers, skills and home path replaced with neutral values. `cursor_run.jsonl` has had its
session id, request id and recording path replaced the same way. `agy_run.jsonl` has had its
`init` tool list narrowed to a neutral set, and its conversation id, recording path and the
username inside a shell tool's output replaced. Both `opencode` fixtures have had their session id
and recording path replaced, and `opencode_failed.jsonl` its error `ref`. Nothing a parser looks at was
touched; the point is that a fixture should not publish whatever the person who recorded it
happened to have connected.

To re-record, run the command in the table with stdout redirected to the file, scrub the init
event the same way, and note the new version here.
