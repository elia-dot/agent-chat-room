/**
 * `@runtime` mentions in the composer.
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
 *
 * `symbol` is what makes the same machinery drive `#room` references: the two behave
 * identically in the composer and differ only in what the list offers.
 */
export function mentionAtCaret(value: string, caret: number, symbol = '@'): MentionQuery | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf(symbol);
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
  symbol = '@',
): { value: string; caret: number } {
  const head = `${value.slice(0, mention.at)}${symbol}${runtime} `;
  // The completion supplies its own trailing space, so completing mid-sentence must not
  // leave a double one where the old mention already had one after it.
  const tail = value.slice(mention.at + 1 + mention.query.length).replace(/^ /, '');
  return { value: head + tail, caret: head.length };
}

/** A room the composer can reference, as the `#` list shows it. */
export interface RoomOption {
  id: string;
  slug: string;
  title: string;
}

const ROOM_REF_RE = /(?:^|\s)#([A-Za-z0-9][\w-]*)/g;

/**
 * Every `#room-slug` in the message, as room ids.
 *
 * Anywhere in the text, unlike `@mentions`: a mention routes the next turn and so has to be
 * an instruction rather than a passing reference, but "compare this with #flaky-login" means
 * the same thing wherever it appears. An unknown slug is left alone – it is a word with a
 * hash in front of it, which is what an issue number looks like.
 */
export function parseRoomRefs(input: string, rooms: readonly RoomOption[]): string[] {
  const ids: string[] = [];
  for (const match of input.matchAll(ROOM_REF_RE)) {
    const slug = match[1]!.toLowerCase();
    const room = rooms.find((r) => r.slug.toLowerCase() === slug);
    if (room && !ids.includes(room.id)) ids.push(room.id);
  }
  return ids;
}

/** Rooms matching what has been typed after the `#`, newest first. Slug or title. */
export function roomCompletions(query: string, rooms: readonly RoomOption[]): RoomOption[] {
  if (!query) return rooms.slice(0, 6);
  return rooms
    .filter((r) => r.slug.toLowerCase().startsWith(query) || r.title.toLowerCase().includes(query))
    .slice(0, 6);
}
