# Prompt construction and context reuse

How ACR assembles each turn's prompt, and what it deliberately does not resend. Everything
described here is implemented and covered by tests; this is not a roadmap.

## Instruction deduplication

Adapters declare `systemAppendDelivery` in their capabilities (`packages/core/src/types.ts`).
The engine omits the inline role block only when the adapter delivers `systemAppend` in that
same turn:

| Delivery | Adapters | Inline role block |
|---|---|---|
| `every-turn` | Claude | Omitted on every turn |
| `first-turn` | Codex, Cursor, Antigravity, opencode | Omitted on fresh sessions only |
| unset | `echo` | Always inlined, the original behavior |

Resumed sessions for the `first-turn` adapters still get current role, phase and
round-specific rules inline, because those runtimes do not resend `systemAppend` on resume.
The dispatch is in `RoomEngine.runParticipantTurn` (`packages/core/src/engine/room.ts`).

`buildTurnPrompt` (`packages/core/src/prompt.ts`) defaults to including instructions, so
standalone callers remain safe. Role-change notices, task text, messages, diffs, test
evidence, permissions and round limits are unchanged. This removes one role block per
eligible turn; it does not claim a measured provider-token or cost reduction. Prompt tests
compare bytes, and engine tests cover fresh and resumed delivery through the real adapter
prompt/argument builders.

## What the engine already reuses

- **Sessions, not transcripts.** `runParticipantTurn` persists runtime session IDs and passes
  them into later turns. `unseenFor` sends each participant only the messages after their own
  watermark, excluding messages they wrote. ACR does not normally replay the whole room
  transcript on every turn.
- **Large diffs by reference.** Diffs above `DEFAULT_MAX_INLINE_DIFF_BYTES` (60 KiB, in
  `packages/core/src/prompt.ts`) are referenced rather than inlined. The engine spills them to
  readable files so reviewers without shell access can still reach the full evidence.
- **Usage capture.** The Codex parser records input, output and cached input usage
  (`packages/core/src/adapters/codex.ts`), and the engine stores per-turn usage.

Session reuse avoids duplicate transcript injection, but it does not make the runtime's
accumulated context free. Long-lived sessions still need context management, and ACR does not
currently do any of its own.
