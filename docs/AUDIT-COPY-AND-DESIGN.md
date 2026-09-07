# Copy and design audit

Scope: the web UI (`packages/web/src`) and the strings `acr` prints (`packages/cli/src`).
Findings are ordered by consequence, not by file. Every one names the line it is about.

Nothing in this document has been applied. It is a list of defects, not a changelog.

---

## Part 1 – Copy

### 1.1 The app contradicts itself about where a room runs

Three surfaces make three different claims about the same default.

| Surface | Says |
| --- | --- |
| `packages/core/src/config.ts:137` | `worktree: true` is the built-in default |
| `packages/cli/src/main.ts:95` | "Every room runs on its own branch `acr/<slug>` in a git worktree ... so your checkout is never touched" |
| `packages/web/src/components/NewRoomDialog.tsx:54` | the checkbox initialises to `false` |
| `packages/web/src/components/NewRoomDialog.tsx:466` | the unchecked state is labelled "default · agents work in your checkout" |
| `packages/web/src/components/RoomsOverlay.tsx:165` | "One agent builds in an isolated worktree" |

So the empty state promises isolation, the dialog immediately opts you out of it and calls
that the default, and the CLI help says isolation is unconditional twenty lines after
documenting `--no-worktree`.

This is the worst copy defect in the app, because it is the one sentence a new user reads
before handing four agent processes write access to a directory. Two of the three
statements are false in the web UI's own default path.

Fix: pick one default, make `NewRoomDialog`'s initial state match `BUILTIN_DEFAULTS`, and
reword `main.ts:95` to "By default every room runs ... `--no-worktree` works in your
checkout instead." Then reword the empty state to describe whichever default won.

### 1.2 A ternary whose two branches are the same sentence

`packages/web/src/components/Composer.tsx:184-188`

```tsx
) : running ? (
  'interject any time — the room keeps working'
) : (
  'interject any time — the room keeps working'
)
```

Someone intended the composer hint to differ while a turn is in flight and it never
shipped. As written the `running` test is dead code. Either delete the branch or give the
running case the line it was reaching for ("a turn is running – your message lands after
it" would be the honest one, since `api.say` holds the loop).

### 1.3 Backticks rendered as literal backticks

`packages/web/src/components/DoctorPage.tsx:82`

```tsx
one to build and at least one to review. `acr` never reads your credentials – it
```

This is JSX text, not markdown. The user sees `` `acr` `` with the backticks. Use
`<code>` or the existing `font-mono` class, which is what every other component does.

### 1.4 "pr opened" is a state wearing an action's clothes

`packages/web/src/components/ActionsOverlay.tsx:92` – the button label flips to
`pr opened` once `room.prUrl` is set, but the button stays enabled and still calls
`onOpenPr`. A button in a row of verbs (`commit`, `open pr`) that suddenly reads as a past
participle is telling you a fact from a control that will act if you press it. Either
disable it and move the fact to the `Fact label="pr"` row that already exists in
`RoomOverlay.tsx:85`, or keep it as a link to the PR.

### 1.5 Two glyphs for one meaning

The codebase uses two different dashes for "no value":

- en dash `–` in `format.ts:101`, `PhaseStrip.tsx:92`, `RoomOverlay.tsx:77`, `DoctorPage.tsx:64`
- em dash `—` in `NewRoomDialog.tsx:421` and `NewRoomDialog.tsx:544`

Pick the en dash (it is the majority and it matches the project's dash convention) and use
it in both `NewRoomDialog` sites.

The same convention is broken in five prose strings that use a real em dash as sentence
punctuation: `ActionsOverlay.tsx:61`, `ProposalCard.tsx:64`, `VerdictCard.tsx:68`,
`Composer.tsx:155`, `Composer.tsx:181`. These should be en dashes.

### 1.6 Purge asks you to retype a sentence

`packages/web/src/components/ActionsOverlay.tsx:115` passes `expect={room.title}` to
`TypeToConfirm`. Room titles default to "the first line of the task"
(`packages/cli/src/main.ts:82`), which in practice is a full sentence like
*"The login test is flaky. Find out why and fix it."*

Type-to-confirm works because the string is short, memorable and identifying: `main`,
`delete`, a repo name. A 50-character sentence is not a confirmation gesture, it is a
copy-paste exercise, and the fastest way through it is to select the placeholder text with
the mouse. That is the same muscle-memory bypass the doc comment at `Confirm.tsx:80-83`
says the control exists to prevent.

Use the short room id (`shortId` already exists in `format.ts:95`) or the word `purge`.

### 1.7 The register drifts between lowercase-terse and sentence prose

The app has a deliberate voice: lowercase, mono, terse ("interject any time", "markdown
ok", "nothing yet – the folders you open rooms on show up here"). It is good and it is
consistent almost everywhere. The exceptions read as leftovers:

- `AdditionalDirsEditor.tsx:118` – `Add`, capitalised, next to lowercase `remove` on line 90.
- `RoomOverlay.tsx:155` – `Nothing changed yet.` (sentence case, full stop) directly under
  `loading…` on line 153 (lowercase, no stop).
- `RoomOverlay.tsx:228` – `Only the room repository is accessible.`
- `DiffViewer.tsx:25` – `This message changed no files.`
- `ActionsOverlay.tsx:108,113` – `Close room`, `Purge worktree & data` are capitalised
  while every other action in the same overlay is lowercase.
- `DoctorPage.tsx:31` – `Doctor` page uses sentence case throughout while the rest of the
  app uses mono small-caps section labels.

Not all of these are wrong. Capitalising the two destructive actions may be deliberate
emphasis. But `Add`, `Nothing changed yet.` and `This message changed no files.` are not.

### 1.8 Minor, but worth a pass

- `packages/web/src/components/Composer.tsx:200` – the button says `start` for a room that
  has never run and `continue` otherwise, but the surrounding band at line 104 says
  "continue as it stands, or stop the room". If the button can say `start`, the band
  should not promise a `continue`.
- `packages/web/src/components/RoundStrip.tsx:69` – `· 2m 10s in room` reads as a typo for
  "in the room". "open 2m 10s" or "age 2m 10s" is cleaner.
- `packages/web/src/App.tsx:524` – the banner's dismiss control is the lowercase word
  `dismiss` in mono with no border or icon. It does not read as pressable.
- `packages/web/src/components/DiffViewer.tsx:6-10` – the doc comment describes "the right
  panel ... 340px wide". The panel is 420px (`Overlay.tsx:38`). Stale.

---

## Part 2 – Design

### 2.1 Five components never joined the token system

`index.css:9-20` states the design's central rule: every colour goes through an `@theme`
variable so "`bg-raised` means the same thing in both themes and there is no `dark:` twin
to keep in sync."

Five components ignore it entirely and hand-roll Tailwind's stock palette with `dark:`
twins:

| File | Colours used |
| --- | --- |
| `components/DiffViewer.tsx` | `zinc-200/400/500/50/800/900`, `emerald-500/600/400`, `rose-500/600/400`, `sky-500/700/400` |
| `components/DoctorPage.tsx` | `zinc-100/200/500/800/900`, `rose-600/400`, `amber-600/400` |
| `components/ModelSelect.tsx` | `zinc-300/500/700/950`, `amber-600/400` |
| `components/ActivityDrawer.tsx` | `zinc-200/400/500/600/800/900` |
| `components/FolderPickerButton.tsx` | `zinc-100/300/600/700/800` |

Consequences that are visible, not theoretical:

1. **The neutrals are the wrong hue.** Every token neutral sits on hue 255 at chroma
   ≤ 0.014. Tailwind `zinc` sits near hue 286. Put a `DiffViewer` panel next to an
   `Overlay` and the greys do not match.
2. **The semantic colours are duplicated and diverge.** `DiffViewer` says additions are
   `emerald` and deletions are `rose`; the token system says approve is `--acr-approve`
   and error is `--acr-error`. Two vocabularies for the same green and the same red.
3. **`FolderPickerButton` has no dark background token at all.** It sets
   `dark:border-zinc-700 dark:text-zinc-300` but no background, so it inherits whatever it
   is dropped on. In `NewRoomDialog` that is `bg-ground`; the sibling input on line 228 is
   `bg-surface`. The two controls in the same row do not sit on the same plane.
4. `ModelSelect.tsx:64` hardcodes `bg-white dark:bg-zinc-950` for a select that appears
   inside `bg-surface` (light: pure white) and `bg-ground` (dark: `oklch(0.165)`). Neither
   matches.

This is the largest single design finding. It is also the cheapest to fix: the mapping is
mechanical (`zinc-500` → `ink-dim`, `zinc-400` → `ink-faint`, `emerald` → `approve`,
`rose` → `error`, `sky` → `live`, `amber` → `question`) and it deletes every `dark:` in the
`packages/web` tree.

### 2.2 The round strip encodes outcome in hue alone

`components/VerdictPill.tsx:5-12` states the rule explicitly:

> A glyph does the work colour cannot – it survives a colour-blind reader, a bad monitor
> and a screenshot pasted into a chat – so approve, request-changes and question are never
> distinguished by hue alone.

`components/RoundStrip.tsx:52-62` breaks it. A finished round is a 26×16px rectangle whose
only distinguishing feature is `bg-approve-bg` vs `bg-changes-bg` vs `bg-question-bg` vs
`bg-error-bg` – four low-chroma tints, no glyph, no text, no pattern. The whole point of
the strip is "the shape of the argument is legible in a single glance"
(`RoundStrip.tsx:28-30`), and for a deuteranopic reader the changes/approved distinction
is the one that carries the argument.

The cells are large enough for a single character. `✓ ! ? ×` at 9px would fix it and would
match `PhaseStrip.tsx:47`, which already does exactly this.

Related: the legend at `RoundStrip.tsx:74` is `hidden ... xl:flex`, so below 1280px the
colour code has no key at all.

### 2.3 Hold-to-confirm fires after you let go, and can fire more than once

`components/Confirm.tsx:24-62`. Holding Space or Enter fires `keydown` repeatedly, and
each repeat calls `begin()`, which does two things: it resets `start.current` and it starts
a fresh `requestAnimationFrame` loop, overwriting `frame.current` and orphaning the
previous loop. A one-second hold therefore leaves a dozen or more live loops behind it.

Two consequences, and neither is the one you would guess.

**While the key is held, the bar never fills.** Every loop reads the same shared
`start.current`, which each repeat pushes forward. The ratio restarts on every repeat, so
it does not reach 1 for as long as the key is down. The affordance appears not to work.

**On release, the action fires anyway – roughly 900ms late.** `stop()` cancels
`frame.current`, which is a single handle: whichever loop happened to schedule last. Every
other orphan is still pending. They keep ticking against a `start.current` that is now
frozen at the final repeat, so 900ms after the last repeat they cross the threshold and
call `onConfirm()`. The user let go, watched the progress bar reset to zero, and the room
closes a beat later with nothing on screen connecting the two.

**And it can fire repeatedly.** Several orphans cross the threshold in the same frame or in
consecutive ones. The first calls `stop()` (cancelling one handle) and `onConfirm()`; the
rest call `onConfirm()` again. `onCloseRoom` in `ActionsOverlay.tsx:110` is not idempotent
from the UI's side – it goes through `App.tsx:486`, which fires an `api.close` per call.

This is worse than an unreachable control. An unreachable control is visibly broken; this
one looks cancelled and then acts.

Fix: guard `begin()` with `if (frame.current !== null) return;` so at most one loop exists.
That makes `start.current` stable across repeats (the hold accumulates from the first
keydown and completes while still held), and it makes `stop()` total, since there is only
ever one handle to cancel. Add `e.preventDefault()` in the `keydown` handler so Space does
not also scroll the overlay.

Whatever the fix, it needs to be validated against all four cases, not just the happy one:

1. Hold past 900ms with the pointer → fires exactly once.
2. Hold past 900ms with the keyboard, through key repeat → fires exactly once.
3. **Release before 900ms → does not fire, then or later.** This is the case the current
   code gets wrong, and the one a naive fix is most likely to leave broken.
4. `pointerleave` mid-hold → same as 3.

### 2.4 No dialog semantics and no live regions anywhere

`grep -rn 'role="dialog"\|aria-modal\|aria-live\|role="status"\|role="alert"' packages/web/src`
returns nothing.

- `Overlay.tsx:41-68` and `NewRoomDialog.tsx:185` are modal in behaviour (backdrop, Escape,
  focus-stealing) but not in semantics. No `role="dialog"`, no `aria-modal="true"`, no
  `aria-labelledby` pointing at the `<h2>` that is already there, no focus trap, and no
  focus restore to the control that opened them. Tab from inside an overlay walks straight
  into the transcript behind it.
- The streaming transcript, the `NEEDS YOU` band (`Composer.tsx:99`), the `FINISHED` band
  (`Composer.tsx:110`), the error banner (`App.tsx:314`) and the `CONNECTION LOST` panel
  (`DisconnectedPanel.tsx:51`) are all silent to a screen reader. The error banner and the
  disconnected panel in particular are the two things that most need announcing, because
  they mean the thing you just typed did not happen.

`role="alert"` on the banner, `role="status"` on the state bands, and `role="dialog"` +
`aria-modal` + `aria-labelledby` on `Overlay` and `NewRoomDialog` cover most of this
without restructuring anything.

### 2.5 Focus is invisible on every text input

Seven places set `focus:outline-none`:

- `NewRoomDialog.tsx:228, 337, 347`, `RoomsOverlay.tsx:54`, `AdditionalDirsEditor.tsx:108`
  replace the outline with `focus:border-line-strong`. That is a one-pixel border moving
  from `oklch(0.88)` to `oklch(0.82)` in light mode – a change most people will not see, on
  a control that already has a border.
- `Composer.tsx:166` is covered by the parent's `focus-within:border-line-strong`, so it is
  the least bad of the seven.
- `Confirm.tsx:139` – the purge input – removes the outline and adds **nothing**. There is
  no focus indication at all on the most dangerous field in the app.

There is no `focus-visible` rule anywhere in `packages/web`. A single global
`:focus-visible { outline: 2px solid var(--acr-live); outline-offset: 2px }` in
`index.css` would give the whole app a consistent indicator, and then the seven
`focus:outline-none` calls can go.

### 2.6 The command bar has no answer for a narrow window

`components/CommandBar.tsx:44` is a single non-wrapping flex row. Of its children, the
`ACR` mark, the rooms button, the live pill, the avatar stack, the two `⌥` buttons and the
theme toggle are all `shrink-0`. Only the room title block (line 65) can give ground, and
once it has truncated to nothing everything else overflows the 46px strip. There is no
`overflow-hidden`, no wrap, and no breakpoint below `lg:` (line 68) or `xl:`
(`RoundStrip.tsx:74`).

The app is a localhost tool, so a phone is not the case to design for. A half-width window
on a laptop is, and that is where this breaks.

### 2.7 The live turn indicator can name the wrong agent

`App.tsx:532-542`

```ts
function elapsedOf(turns, _author, now) {
  const open = turns.filter((t) => !t.endedAt);
  const started = open.length > 0 ? Date.parse(open[open.length - 1]!.startedAt) : NaN;
```

The `_author` parameter is accepted and discarded. The function returns the elapsed time of
the *newest* open turn regardless of who is taking it, and the result is rendered next to
`live.author` in `CommandBar.tsx:82-84`. In `waiting-reviews`, where several reviewer turns
are open at once, the bar shows one agent's name beside another agent's clock.

Either filter `open` by `participantId` matching the author, or drop the name from the
pill and label it "turn 1:23" so it stops claiming something it does not know.

### 2.8 Smaller design notes

- **Duplicated helper.** `CommandBar.tsx:143` redefines `basename`, which `lib/format.ts:119`
  already exports and which `CommandBar` could import in one line.
- **Nested scroll containers.** `NewRoomDialog.tsx:185` scrolls (`overflow-y-auto` on the
  backdrop) and `NewRoomDialog.tsx:218` scrolls too (`max-h-[70vh] overflow-y-auto`). On a
  short window the wheel behaviour depends on which of the two the pointer is over.
- **Truncation without a mark.** `Transcript.tsx:176` cuts a folded message at 160
  characters with no ellipsis, so a truncated line is indistinguishable from a short one.
- **`opacity-55` as the "off" state.** `NewRoomDialog.tsx:374` dims an entire table row to
  55% to mean "not in the roster". That takes `text-ink-faint` (already the lightest ink)
  to roughly a third of its contrast against the row background. A struck-through or
  explicitly neutral treatment holds up better than a blanket alpha.
- **`ink-faint` carries load-bearing copy at 10px.** It is the palette's lightest ink and it
  is used for the roster hints (`NewRoomDialog.tsx:352`), the workspace explainer (line 466),
  the retry explainer (line 490) and the footer summary (line 504) – all real information,
  most of it at 10–11px. Worth measuring against WCAG AA and demoting some of it to
  `ink-dim`; I was not able to run the contrast numbers in this environment, so this is
  flagged rather than asserted.
- **Two confirmation idioms in one panel.** `ActionsOverlay` uses hold-to-confirm for close
  and type-to-confirm for purge, and `App.tsx:469` uses a native `window.confirm()` for
  "Open PR". Three gestures for three consequential actions. The `window.confirm` in
  particular is the one that cannot be styled, cannot be dismissed with the app's own
  Escape handling, and is the only place the app's voice breaks entirely.

---

## What is not wrong

Worth recording, so a future pass does not "fix" it:

- The design-rationale comments at the top of each component are unusually good and should
  survive any refactor. `MessageBubble.tsx:28-39`, `RoundStrip.tsx:24-31` and
  `DisconnectedPanel.tsx:14-24` each explain a decision that is not visible from the code.
- `DisconnectedPanel` is the strongest screen in the app. It says what broke, how stale the
  view is, and the exact command to run, and it keeps the transcript visible behind it.
- The `SystemLine` classifier (`SystemLine.tsx:30-70`) falling through to a neutral note for
  anything it does not recognise is the right default and the comment says why.
- The verdict digest (`VerdictCard.tsx:38-49`), which collapses a clean approval to one
  line, is the single best hierarchy decision in the transcript.
