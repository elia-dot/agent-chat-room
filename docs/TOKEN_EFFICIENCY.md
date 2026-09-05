# Token efficiency without limiting rounds

This audit proposes token-saving improvements while preserving task quality, history
access, and room scheduling. Recommendations are not implemented runtime features.

## What already works

- `packages/core/src/engine/room.ts`: `runParticipantTurn` persists runtime session IDs
  and passes them into later turns. `unseenFor` sends messages after each participant's
  watermark and excludes that participant's own messages. ACR does not normally replay
  the entire room transcript on every turn.
- `packages/core/src/prompt.ts`: diffs above 60 KiB are referenced rather than inlined.
  The engine spills these to readable files for reviewers without shell access.
- `packages/core/src/adapters/codex.ts`: resumed turns omit the initial `systemAppend`;
  the parser captures input, output, and cached input usage. The engine stores turn usage.

Session reuse avoids duplicate transcript injection, but does not make the runtime's
accumulated context free. Long-lived sessions still need context management.

## Prioritized opportunities

1. **Measure before changing context.** Compare representative short and long rooms,
   including role swaps, failed turns, and late-joining participants. Record prompt bytes
   by section (task, instructions, messages, diff, test output), provider-reported input,
   cached input and output tokens, and test/review outcomes. Bytes are not tokens; missing
   usage is unknown, not zero. Compare total cost per completed task, not just per turn.
2. **Remove provably redundant injection.** `buildTurnPrompt` repeats the task and role
   instructions every turn (`packages/core/src/prompt.ts:126`); the engine also supplies
   `systemAppend` (`packages/core/src/engine/room.ts:1334`). A possible
   first code change is eliminating the same-turn duplicate while retaining the full role
   contract once. Inspect each adapter's instruction precedence first. Claude resends
   `systemAppend` on resume (`packages/core/src/adapters/claude.ts:42`); Codex, Cursor,
   and Antigravity do not (`packages/core/src/adapters/codex.ts:110`,
   `packages/core/src/adapters/cursor.ts:107`, `packages/core/src/adapters/antigravity.ts:93`).
   Removing the prompt copy on every turn therefore needs adapter-aware handling, not
   a blanket deletion: resumed turns must still receive current role/phase instructions.
   Keep role-change
   notices and fresh-session bootstrap intact; do not deduplicate arbitrary owner messages
   just because their text matches an earlier message.
3. **Avoid repeatedly inlining unchanged large artifacts.** Consider stable diff/test-log
   references with content hashes, plus changed-file summaries. Preserve access to full
   evidence for read-only reviewers. Invalidate on content changes, not just round number;
   a new or reset session still needs complete context. Moving text to a file only saves
   tokens when the agent can avoid reading all of it again.
4. **Keep tool output targeted.** Search symbols and read relevant ranges before dumping
   entire files. For large logs, provide failure locations and a readable full-log path.
   Expand searches when evidence is incomplete. Never suppress failures or skip tests to
   save tokens. Prefer concise decision/evidence/blocker updates over repeated narratives.
5. **Evaluate compaction for genuinely long sessions.** Prefer runtime-supported context
   management over ACR deleting messages. A future checkpoint should retain the current
   task, owner constraints, decisions and rationale, unresolved issues, changed files,
   validation results, and pointers to original evidence. Test recovery and requirement
   recall before enabling it. Summaries can lose information and also cost tokens to create.

None of these proposals requires a round or tool-call cap, a smaller model, less reasoning,
or weaker review. Quality preservation must be measured, not promised.

## Known methods and skills

The following official pages were fetched and their relevant content checked on
2026-09-05. API features and interactive CLI commands are not necessarily exposed by ACR.

- **Prompt caching:** stable prefixes can reduce repeated-input cost and latency without
  removing information. Cached text still occupies context; caching is not context
  compression. ACR delegates requests to CLIs, so API cache controls are not automatically
  ACR settings. See [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
- **Compaction:** OpenAI provides context compaction for long-running API conversations.
  This is a method to evaluate, not an endpoint to graft onto opaque CLI sessions. Check
  each runtime's supported integration separately. See [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction).
  Claude Code also manages context with automatic compaction and an interactive
  `/compact` command; see [Claude Code context management](https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up).
  Do not assume sending that slash command through ACR's headless adapter invokes it.
- **Progressive-disclosure skills:** keep a small workflow entry point and load detailed
  references only when needed. Skill names/descriptions have their own context overhead;
  installing many generic “save tokens” skills can be counterproductive. See
  [Codex skill documentation](https://developers.openai.com/codex/skills/) and
  [Claude Code skills](https://code.claude.com/docs/en/skills).
  The Codex URL currently redirects to `learn.chatgpt.com/docs/build-skills`; that page
  explicitly covers Codex CLI, progressive disclosure, and repository skill discovery.

Useful candidates for a later, opt-in skill are a **focused repository investigation**
workflow (locate symbols, read relevant source, expand as needed) and an **evidence-backed
handoff** workflow (checkpoint the facts above at a milestone, not every turn). Neither
should impose response-length limits that hide evidence or automatically erase history.
Keep permission rules and essential task constraints in always-present instructions,
not an optional skill. Verify skill discovery in the actual room runtime: the Codex
adapter passes `--ignore-user-config`, and the Claude adapter passes `--setting-sources
project` (`packages/core/src/adapters/claude.ts:36`). Changing personal configuration
alone is not a reliable room-level integration strategy; these settings flags do not
by themselves establish which skill directories each runtime discovers.

## Recommended scope

Start with prompt-section measurement and same-turn instruction deduplication, protected
by adapter/prompt tests. Then evaluate artifact reuse and checkpointing on long-room
fixtures against the unchanged baseline. Require preserved owner constraints, role
permissions, test evidence, and review correctness before rollout. Keep model settings,
round limits, and history retention unchanged during the initial evaluation.
