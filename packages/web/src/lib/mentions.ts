/**
 * `@runtime` mentions in the composer (PLAN.md section 5.3).
 *
 * Pure and exported so it can be unit-tested without a DOM – the composer itself is a
 * textarea and three buttons, and this is the only part of it worth pinning.
 */

export interface ParsedMessage {
  /** The runtime the next turn goes to, or null for "whoever the room would pick". */
  mention: string | null;
  /** The submitted message, trimmed but otherwise preserved for the transcript. */
  text: string;
}

const MENTION_RE = /^@([A-Za-z0-9][\w-]*)\s*/;

/**
 * Read a leading `@mention` against the room's roster.
 *
 * Only a *leading* mention routes the turn. "ask @codex about this" is a sentence about
 * codex, not an instruction to hand it the next turn, and quietly rerouting on it would be
 * the kind of surprise that makes people stop typing names.
 */
export function parseMention(input: string, runtimes: readonly string[]): ParsedMessage {
  const text = input.trimStart();
  const match = MENTION_RE.exec(text);
  if (!match) return { mention: null, text: input.trim() };

  const name = match[1]!;
  const target = runtimes.find((r) => r.toLowerCase() === name.toLowerCase());
  // An unknown name stays in the text. Silently dropping "@gemini" would make the message
  // read as if it were addressed to nobody.
  if (!target) return { mention: null, text: input.trim() };

  return { mention: target, text: input.trim() };
}

export interface MentionQuery {
  /** What the user has typed after the `@`, lowercased. */
  query: string;
  /** Index of the `@` in the raw value, for splicing the completion back in. */
  at: number;
}

/**
 * The `@` the caret is currently inside, if any. Returns null when there is nothing to
 * complete, which is the common case and has to be cheap.
 */
export function mentionAtCaret(value: string, caret: number): MentionQuery | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  // A mention starts a word: `foo@bar` is an email address, not a mention.
  if (at > 0 && !/\s/.test(before[at - 1] ?? '')) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { query: query.toLowerCase(), at };
}

/** Runtimes matching what has been typed so far, in roster order. */
export function completions(query: string, runtimes: readonly string[]): string[] {
  return runtimes.filter((r) => r.toLowerCase().startsWith(query));
}

/** Replace the mention the caret is in with `runtime`, and say where the caret lands. */
export function applyCompletion(
  value: string,
  mention: MentionQuery,
  runtime: string,
): { value: string; caret: number } {
  const head = `${value.slice(0, mention.at)}@${runtime} `;
  // The completion supplies its own trailing space, so completing mid-sentence must not
  // leave a double one where the old mention already had one after it.
  const tail = value.slice(mention.at + 1 + mention.query.length).replace(/^ /, '');
  return { value: head + tail, caret: head.length };
}
