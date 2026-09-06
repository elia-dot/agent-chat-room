import type { AgentAdapter } from './types.js';
import { slugify } from './worktree.js';

/**
 * Where `acr/<slug>` comes from when the human did not name the room.
 *
 * Before this, the slug was the first line of the task cut at 40 characters, which for a
 * task written as a sentence produced branches like `acr/right-now-the-name-of-the-branch-crea`.
 * Two things replace that: a short read-only turn on the room's own worker runtime that is
 * asked for a branch name, and – when that is unavailable, disabled or answers with junk –
 * a purely local condensation of the task. A title, when given, still wins over both.
 */

/**
 * Leading throat-clearing. Stripped as phrases, longest first, and repeatedly: a task very
 * often opens with two or three of these in a row ("right now the …", "i want to …").
 */
const LEADING_FILLER = [
  'at the moment',
  'i would like to',
  'i would like',
  'it would be nice if',
  'i want to',
  'i want',
  'i need to',
  'i need',
  'we need to',
  'we need',
  'we should',
  'it should',
  'can you',
  'could you',
  'please',
  'right now',
  'currently',
  'today',
  'also',
  'and',
  'so',
  'but',
  'just',
  'the',
  'a',
  'an',
  'now',
];

/**
 * Function words dropped from anywhere in the task. Deliberately small: verbs and negations
 * stay, because `fix-not-found-error` and `fix-found-error` are different branches.
 */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'out',
  'should',
  'so',
  'than',
  'that',
  'the',
  'their',
  'then',
  'there',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

/** How many significant words a condensed slug keeps. */
const MAX_WORDS = 5;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function stripLeadingFiller(input: string[]): string[] {
  let rest = input;
  let changed = true;
  while (changed && rest.length > 0) {
    changed = false;
    for (const phrase of LEADING_FILLER) {
      const parts = phrase.split(' ');
      if (parts.length >= rest.length) continue;
      if (parts.every((word, i) => rest[i] === word)) {
        rest = rest.slice(parts.length);
        changed = true;
        break;
      }
    }
  }
  return rest;
}

/**
 * A readable slug built from the task alone: no runtime, no network, no latency. Used as the
 * fallback whenever the naming turn is skipped or fails, so a machine with no usable runtime
 * still gets `acr/name-branch-created-build-room` rather than a mid-word truncation.
 */
export function condenseSlug(task: string, fallback = 'room'): string {
  const all = words(task);
  const rest = stripLeadingFiller(all);
  const significant = rest.filter((word) => !STOP_WORDS.has(word));
  const picked = (significant.length > 0 ? significant : rest.length > 0 ? rest : all).slice(
    0,
    MAX_WORDS,
  );
  return slugify(picked.join(' '), fallback);
}

/** The one-shot prompt sent to the worker runtime. Short on purpose: this is not a room turn. */
export function buildBranchNamePrompt(task: string): string {
  return [
    'Name the git branch for the task below.',
    '',
    'Reply with ONLY a lowercase kebab-case branch name: 2 to 5 words, at most 40 characters,',
    'no `acr/` prefix, no quotes, no explanation. Describe the change, not the conversation.',
    '',
    'Task:',
    task.trim(),
  ].join('\n');
}

/** A suggestion is at most this many dash-separated words; more means the model wrote prose. */
const MAX_SUGGESTION_SEGMENTS = 6;

/**
 * Turn whatever the runtime said into a slug, or `null` when it did not answer with a name.
 *
 * Lines are read from the bottom up because a model that ignores "no explanation" puts the
 * answer either last or first with prose after it; a prose line fails the segment check and
 * the scan moves on. Everything that survives has been through `slugify`, so the caller can
 * only ever receive `[a-z0-9-]{1,40}`.
 */
export function cleanBranchSuggestion(raw: string): string | null {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = lines[i]!.replace(/[`'"*]/g, ' ')
      .replace(/^\s*(?:branch\s*name|branch|name)\s*[:=-]\s*/i, ' ')
      .replace(/\bacr\//gi, ' ')
      .trim();
    // Sentence punctuation is the tell that this line is prose rather than a name.
    if (/[.,;:!?]/.test(candidate)) continue;
    const slug = slugify(candidate, '');
    if (!slug) continue;
    if (slug.split('-').length > MAX_SUGGESTION_SEGMENTS) continue;
    return slug;
  }
  return null;
}

export interface BranchNameContext {
  task: string;
  /** The room title, for a namer that wants it. `agentBranchNamer` names from the task. */
  title: string;
  repoRoot: string;
  /** The room's first runtime, already resolved from the roster. */
  adapter: AgentAdapter;
  model?: string;
}

/** Injected on `RoomEngineOptions`. Returning `null` means "use the local fallback". */
export type BranchNamer = (ctx: BranchNameContext) => Promise<string | null>;

/** Per-turn stall timeout for the naming turn. */
const NAMING_STALL_MS = 20_000;
/** Wall clock after which the naming turn is cancelled outright. */
const NAMING_DEADLINE_MS = 45_000;

/**
 * Ask the room's own worker runtime for a branch name.
 *
 * Never throws and never rejects: room creation must not fail because a CLI is missing, not
 * logged in, or feeling chatty. Every failure mode returns `null` and the caller condenses
 * the task instead. Set `ACR_NO_AUTO_BRANCH_NAME=1` to skip the call entirely.
 */
export const agentBranchNamer: BranchNamer = async (ctx) => {
  if (process.env.ACR_NO_AUTO_BRANCH_NAME) return null;

  let deadline: NodeJS.Timeout | undefined;
  try {
    const handle = ctx.adapter.run(
      {
        cwd: ctx.repoRoot,
        prompt: buildBranchNamePrompt(ctx.task),
        permission: 'read-only',
        timeoutMs: NAMING_STALL_MS,
        ...(ctx.model ? { model: ctx.model } : {}),
      },
      () => {
        // A naming turn has no transcript; its events are of no interest to anyone.
      },
    );
    deadline = setTimeout(() => handle.cancel('branch naming took too long'), NAMING_DEADLINE_MS);
    deadline.unref?.();

    const result = await handle.done;
    if (!result.ok) return null;
    return cleanBranchSuggestion(result.text);
  } catch {
    return null;
  } finally {
    if (deadline) clearTimeout(deadline);
  }
};
