import { describe, expect, it } from 'vitest';

import { diffSummary, parseUnifiedDiff } from '../src/lib/diff.js';

const MULTI_FILE = `diff --git a/src/auth/redirect.ts b/src/auth/redirect.ts
index 1111111..2222222 100644
--- a/src/auth/redirect.ts
+++ b/src/auth/redirect.ts
@@ -10,7 +10,8 @@ export function redirect(to: string) {
   const url = new URL(to);
-  window.location.href = url.href;
+  // wait for the router to settle first
+  queueMicrotask(() => (window.location.href = url.href));
   return url;
 }
diff --git a/tests/login.spec.ts b/tests/login.spec.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/tests/login.spec.ts
@@ -0,0 +1,3 @@
+test('logs in', async () => {
+  await waitFor(() => expect(page).toHaveURL('/home'));
+});
`;

describe('parseUnifiedDiff', () => {
  it('splits a multi-file diff into files, hunks and typed lines', () => {
    const files = parseUnifiedDiff(MULTI_FILE);
    expect(files.map((f) => f.path)).toEqual(['src/auth/redirect.ts', 'tests/login.spec.ts']);

    const [edited, added] = files;
    expect(edited!.status).toBe('modify');
    expect(edited!.additions).toBe(2);
    expect(edited!.deletions).toBe(1);
    expect(edited!.hunks).toHaveLength(1);

    // Line numbers are what make a diff navigable, and they run on different counters.
    const lines = edited!.hunks[0]!.lines;
    expect(lines[0]).toEqual({
      kind: 'context',
      text: '  const url = new URL(to);',
      oldLine: 10,
      newLine: 10,
    });
    expect(lines[1]!.kind).toBe('del');
    expect(lines[1]!.oldLine).toBe(11);
    expect(lines[1]!.newLine).toBeNull();
    expect(lines[2]!.kind).toBe('add');
    expect(lines[2]!.oldLine).toBeNull();
    expect(lines[2]!.newLine).toBe(11);
    // The context line after the change picks up both counters again.
    expect(lines[4]).toMatchObject({ kind: 'context', oldLine: 12, newLine: 13 });

    expect(added!.status).toBe('add');
    expect(added!.additions).toBe(3);
    expect(added!.deletions).toBe(0);

    expect(diffSummary(files)).toEqual({ additions: 5, deletions: 1 });
  });

  it('reads a rename, with and without an edit', () => {
    const renamed = parseUnifiedDiff(
      `diff --git a/old/name.ts b/new/name.ts
similarity index 92%
rename from old/name.ts
rename to new/name.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
 const b = 3;
`,
    );
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatchObject({
      path: 'new/name.ts',
      oldPath: 'old/name.ts',
      status: 'rename',
      additions: 1,
      deletions: 1,
    });
  });

  it('marks a deletion and a binary file without pretending to have lines', () => {
    const files = parseUnifiedDiff(
      `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-const gone = true;
diff --git a/logo.png b/logo.png
index 4444444..5555555 100644
Binary files a/logo.png and b/logo.png differ
`,
    );
    expect(files[0]).toMatchObject({ status: 'delete', deletions: 1, additions: 0 });
    expect(files[1]).toMatchObject({ path: 'logo.png', binary: true, hunks: [] });
  });

  it('keeps the no-newline marker out of the line numbering', () => {
    const files = parseUnifiedDiff(
      `diff --git a/a.txt b/a.txt
@@ -1,1 +1,1 @@
-one
\\ No newline at end of file
+two
`,
    );
    const lines = files[0]!.hunks[0]!.lines;
    expect(lines.map((l) => l.kind)).toEqual(['del', 'meta', 'add']);
    expect(lines[1]!.oldLine).toBeNull();
    expect(lines[1]!.newLine).toBeNull();
    expect(lines[2]!.newLine).toBe(1);
  });

  it('returns nothing for an empty diff instead of a phantom file', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('\n\n')).toEqual([]);
    expect(diffSummary([])).toEqual({ additions: 0, deletions: 0 });
    // Stray hunk lines with no `diff --git` header belong to nothing.
    expect(parseUnifiedDiff('@@ -1 +1 @@\n+orphan\n')).toEqual([]);
  });
});
