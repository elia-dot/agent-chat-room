import { z } from 'zod';

/**
 * Every reviewer message ends with a fenced ```verdict block.
 *
 * The fence works for every runtime. Runtimes that support schema-constrained output also
 * return the same verdict separately; that validated value wins when prose escaping damages
 * the visible JSON, while the fence remains the portable fallback.
 */
export const VerdictSchema = z.object({
  decision: z.enum(['approve', 'request-changes', 'question']),
  blocking: z.array(z.string()).default([]),
  nits: z.array(z.string()).default([]),
});

export type Verdict = z.infer<typeof VerdictSchema>;
export type VerdictDecision = Verdict['decision'];

/** The same shape as a JSON Schema document, for `--json-schema` and `--output-schema`. */
export const verdictJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['approve', 'request-changes', 'question'] },
    blocking: { type: 'array', items: { type: 'string' } },
    nits: { type: 'array', items: { type: 'string' } },
  },
  required: ['decision', 'blocking', 'nits'],
} as const;

export type ParsedVerdict =
  { ok: true; verdict: Verdict; raw: string } | { ok: false; reason: string };

const FENCE_RE = /```[ \t]*verdict[ \t]*\r?\n([\s\S]*?)```/gi;

/**
 * Pull the verdict out of a reviewer's final message.
 *
 * Returns a result object rather than throwing: "the reviewer forgot the block" is an
 * ordinary outcome the engine has to render, not an exception. When a message contains
 * several blocks the last one wins, since an agent that reconsiders mid-message tends to
 * restate its conclusion at the end.
 */
export function parseVerdict(text: string, structured?: unknown): ParsedVerdict {
  if (structured !== undefined) {
    const parsed = VerdictSchema.safeParse(structured);
    if (parsed.success) {
      return { ok: true, verdict: parsed.data, raw: JSON.stringify(parsed.data) };
    }
  }

  if (!text || text.trim().length === 0) {
    return { ok: false, reason: 'the reviewer produced no text at all' };
  }

  const blocks = [...text.matchAll(FENCE_RE)].map((m) => m[1] ?? '');
  if (blocks.length === 0) {
    const bare = bareVerdict(text);
    if (bare) return bare;
    return {
      ok: false,
      reason: 'no ```verdict block found in the reviewer message',
    };
  }

  const raw = blocks[blocks.length - 1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: `the verdict block is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = VerdictSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.join('.') ?? '';
    return {
      ok: false,
      reason: `the verdict block does not match the schema${where ? ` at "${where}"` : ''}: ${
        issue?.message ?? 'unknown validation error'
      }`,
    };
  }

  return { ok: true, verdict: result.data, raw };
}

/**
 * A runtime with schema-constrained output sometimes prints the verdict object itself as
 * the final output, with no fence around it. That is still a validated verdict, not a guess
 * from prose: it has to be either the entire response or a compact object on the last line,
 * and it has to match the schema exactly, with no unknown keys.
 */
function bareVerdict(text: string): ParsedVerdict | undefined {
  const trimmed = text.trim();
  const lastLine = trimmed.split('\n').at(-1)?.trim() ?? '';
  const raw = trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed : lastLine;
  if (!raw.startsWith('{') || !raw.endsWith('}')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = VerdictSchema.strict().safeParse(parsed);
  return result.success ? { ok: true, verdict: result.data, raw } : undefined;
}

/** How the CLI and (later) the UI label a decision. */
export function decisionLabel(decision: VerdictDecision): string {
  switch (decision) {
    case 'approve':
      return 'APPROVE';
    case 'request-changes':
      return 'REQUEST CHANGES';
    case 'question':
      return 'QUESTION';
  }
}

export interface FileCitation {
  file: string;
  line: number;
}

const KNOWN_EXTENSIONLESS_FILES = new Set([
  'makefile',
  'dockerfile',
  'containerfile',
  'vagrantfile',
  'rakefile',
  'gemfile',
  'procfile',
  'license',
  'notice',
]);

function isLikelyFilePath(path: string): boolean {
  if (path.includes('/') || path.includes('\\')) return true;
  const dotIndex = path.lastIndexOf('.');
  if (dotIndex > 0 && dotIndex < path.length - 1) return true;
  return KNOWN_EXTENSIONLESS_FILES.has(path.toLowerCase());
}

export function parseFileCitations(text: string): FileCitation[] {
  const citationRe = /(?:^|[\s([`'"])((?:[a-zA-Z0-9_.-]+[/\\])*[a-zA-Z0-9_.-]+):(\d+)\b/g;
  const citations: FileCitation[] = [];
  let match: RegExpExecArray | null;
  while ((match = citationRe.exec(text)) !== null) {
    const rawFile = match[1]!;
    if (isLikelyFilePath(rawFile) && rawFile !== 'http' && rawFile !== 'https') {
      citations.push({
        file: rawFile.replace(/\\/g, '/'),
        line: Number.parseInt(match[2]!, 10),
      });
    }
  }
  return citations;
}

const DIFF_FILE_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseModifiedHunks(
  diffText: string,
): Map<string, { start: number; end: number }[]> {
  const map = new Map<string, { start: number; end: number }[]>();
  let currentFile: string | undefined;

  for (const line of diffText.split('\n')) {
    const fileMatch = DIFF_FILE_RE.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[2]!;
      if (!map.has(currentFile)) {
        map.set(currentFile, []);
      }
      continue;
    }
    if (!currentFile) continue;

    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      const newLineStart = Number(hunkMatch[3]);
      const newLineCount = hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1;
      const range = {
        start: newLineStart,
        end: newLineStart + Math.max(newLineCount, 1) - 1,
      };
      map.get(currentFile)?.push(range);
    }
  }

  return map;
}

/**
 * Citations and diff headers rarely agree on how much of the path to write, so either one
 * may be the tail of the other: `lib/foo.dart` matches `app/lib/foo.dart` and vice versa.
 */
function samePath(diffFile: string, normalized: string): boolean {
  return (
    diffFile === normalized ||
    diffFile.endsWith(`/${normalized}`) ||
    normalized.endsWith(`/${diffFile}`)
  );
}

export function isLineInModifiedHunks(
  file: string,
  line: number,
  modifiedMap: Map<string, { start: number; end: number }[]>,
): boolean {
  const normalized = file.replace(/\\/g, '/');
  for (const [diffFile, ranges] of modifiedMap.entries()) {
    if (samePath(diffFile, normalized)) {
      for (const range of ranges) {
        if (line >= range.start && line <= range.end) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Whether the diff says anything at all about this file, whichever lines it touched.
 *
 * This is what separates "the worker did not touch that line" from "this diff cannot
 * answer the question" – a file the diff never mentions could be untouched, or could be in
 * a repository the diff does not cover.
 */
export function isFileInDiff(
  file: string,
  modifiedMap: Map<string, { start: number; end: number }[]>,
): boolean {
  const normalized = file.replace(/\\/g, '/');
  for (const diffFile of modifiedMap.keys()) {
    if (samePath(diffFile, normalized)) return true;
  }
  return false;
}

export interface GoalpostEnforcementResult {
  verdict: Verdict;
  downgraded: { item: string; citations: FileCitation[] }[];
}

/**
 * Mechanical Goalpost Enforcement (starting in Round 3):
 * Compare cited lines from blocking verdict items against git diff hunks.
 * If a blocking citation points to untouched code, downgrade it to a nit.
 *
 * Only a citation the diff can actually adjudicate counts. A file the diff never mentions
 * is unknown, not untouched: it may live in a repository outside this diff, and silently
 * calling that "untouched" is how a real blocking item – or a whole review – disappears.
 * Unknown citations keep their item blocking and leave the decision alone.
 */
export function enforceGoalposts(verdict: Verdict, diffText: string): GoalpostEnforcementResult {
  const modifiedMap = parseModifiedHunks(diffText);
  const remainingBlocking: string[] = [];
  const nits = [...verdict.nits];
  const downgraded: { item: string; citations: FileCitation[] }[] = [];

  for (const item of verdict.blocking) {
    const citations = parseFileCitations(item);
    if (
      citations.length > 0 &&
      citations.every(
        (c) =>
          isFileInDiff(c.file, modifiedMap) && !isLineInModifiedHunks(c.file, c.line, modifiedMap),
      )
    ) {
      downgraded.push({ item, citations });
      nits.push(item);
    } else {
      remainingBlocking.push(item);
    }
  }

  const decision: VerdictDecision =
    verdict.decision === 'request-changes' && remainingBlocking.length === 0
      ? 'approve'
      : verdict.decision;

  return {
    verdict: {
      decision,
      blocking: remainingBlocking,
      nits,
    },
    downgraded,
  };
}
