import { z } from 'zod';

/**
 * Every reviewer message ends with a fenced ```verdict block (PLAN.md section 2).
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
 * the final line, with no fence around it. That is still a validated verdict, not a guess
 * from prose: it has to be a lone JSON object on the last line, and it has to match the
 * schema exactly, with no unknown keys.
 */
function bareVerdict(text: string): ParsedVerdict | undefined {
  const lastLine = text.trim().split('\n').at(-1)?.trim() ?? '';
  if (!lastLine.startsWith('{') || !lastLine.endsWith('}')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    return undefined;
  }
  const result = VerdictSchema.strict().safeParse(parsed);
  return result.success ? { ok: true, verdict: result.data, raw: lastLine } : undefined;
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
