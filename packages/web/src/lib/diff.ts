/**
 * A unified-diff parser, in about eighty lines.
 *
 * Every off-the-shelf diff viewer is heavier than the whole rest of this app, and the
 * thing they buy – side-by-side rendering with syntax highlighting – is not in the M2
 * line. This produces enough structure to render a file tree, a per-file +/- count and
 * coloured hunks, and being pure it is unit-testable without a DOM.
 */

export type DiffLineKind = 'add' | 'del' | 'context' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line number in the old file, for context and deletions. */
  oldLine: number | null;
  /** Line number in the new file, for context and additions. */
  newLine: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** Path as the diff names it. For a rename this is the new name. */
  path: string;
  oldPath: string;
  /** `add` and `delete` are whole-file; `rename` may still carry hunks. */
  status: 'add' | 'delete' | 'modify' | 'rename';
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

const FILE_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of text.split('\n')) {
    const fileMatch = FILE_RE.exec(raw);
    if (fileMatch) {
      file = {
        path: fileMatch[2]!,
        oldPath: fileMatch[1]!,
        status: fileMatch[1] === fileMatch[2] ? 'modify' : 'rename',
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;

    if (raw.startsWith('new file')) {
      file.status = 'add';
      continue;
    }
    if (raw.startsWith('deleted file')) {
      file.status = 'delete';
      continue;
    }
    if (raw.startsWith('Binary files') || raw.startsWith('GIT binary patch')) {
      file.binary = true;
      continue;
    }

    const hunkMatch = HUNK_RE.exec(raw);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (raw.startsWith('+')) {
      file.additions += 1;
      hunk.lines.push({ kind: 'add', text: raw.slice(1), oldLine: null, newLine: newLine++ });
    } else if (raw.startsWith('-')) {
      file.deletions += 1;
      hunk.lines.push({ kind: 'del', text: raw.slice(1), oldLine: oldLine++, newLine: null });
    } else if (raw === '') {
      // Not a diff line: an empty context line is a single space, so a bare empty string is
      // the trailing newline of the document rather than content.
      continue;
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" belongs to the hunk but numbers nothing.
      hunk.lines.push({ kind: 'meta', text: raw, oldLine: null, newLine: null });
    } else {
      hunk.lines.push({
        kind: 'context',
        text: raw.startsWith(' ') ? raw.slice(1) : raw,
        oldLine: oldLine++,
        newLine: newLine++,
      });
    }
  }

  return files;
}

/** `+12 −3`, the label the transcript's diff drawer shows without opening anything. */
export function diffSummary(files: DiffFile[]): { additions: number; deletions: number } {
  return files.reduce(
    (acc, f) => ({
      additions: acc.additions + f.additions,
      deletions: acc.deletions + f.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}
