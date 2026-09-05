import { useState } from 'react';

import type { DiffFile } from '../lib/diff.js';
import { parseUnifiedDiff } from '../lib/diff.js';

/**
 * The diff viewer in the right panel.
 *
 * Unified rather than side-by-side: the panel is 340px wide, and side-by-side in 340px is
 * two columns of nothing. `parseUnifiedDiff` does the work; this only colours it.
 */
export function DiffViewer({
  diff,
  loading,
  basePath,
}: {
  diff: string;
  loading?: boolean;
  basePath?: string;
}): React.ReactElement {
  const files = parseUnifiedDiff(diff);

  if (loading) return <p className="p-3 text-xs text-zinc-500">loading the diff…</p>;
  if (files.length === 0) {
    return <p className="p-3 text-xs text-zinc-500">This message changed no files.</p>;
  }

  return (
    <div className="space-y-2">
      {files.map((file) => (
        <FileDiff key={`${file.oldPath}->${file.path}`} file={file} basePath={basePath} />
      ))}
    </div>
  );
}

function FileDiff({ file, basePath }: { file: DiffFile; basePath?: string }): React.ReactElement {
  const [open, setOpen] = useState(true);
  const basePathClean = basePath ? basePath.replace(/\/+$/, '') : '';
  const fullPath = basePathClean ? `${basePathClean}/${file.path.replace(/^\/+/, '')}` : file.path;
  const absPathWithSlash = fullPath.startsWith('/') ? fullPath : `/${fullPath}`;

  return (
    <section className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
      <div className="flex w-full items-center gap-2 bg-zinc-50 px-2 py-1.5 text-left text-[11px] dark:bg-zinc-900">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="shrink-0 text-zinc-400">{open ? '▾' : '▸'}</span>
          <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
            {file.status === 'rename' ? `${file.oldPath} → ${file.path}` : file.path}
          </span>
        </button>
        <div className="flex items-center gap-1 text-[10px] text-zinc-400">
          <a
            href={`cursor://file${absPathWithSlash}`}
            className="hover:text-sky-500 hover:underline"
            title="Open in Cursor"
          >
            cursor
          </a>
          <span>·</span>
          <a
            href={`vscode://file${absPathWithSlash}`}
            className="hover:text-sky-500 hover:underline"
            title="Open in VSCode"
          >
            vscode
          </a>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2"
        >
          <span className="shrink-0 text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
          <span className="shrink-0 text-rose-600 dark:text-rose-400">−{file.deletions}</span>
        </button>
      </div>

      {open &&
        (file.binary ? (
          <p className="px-2 py-1.5 text-[11px] text-zinc-500">binary file</p>
        ) : (
          <div className="overflow-x-auto font-mono text-[11px] leading-relaxed">
            {file.hunks.map((hunk, i) => (
              <div key={i}>
                <div className="bg-sky-500/10 px-2 text-sky-700 dark:text-sky-400">
                  {hunk.header}
                </div>
                {hunk.lines.map((line, j) => {
                  const lineNum = line.newLine ?? line.oldLine;
                  return (
                    <div
                      key={j}
                      className={`flex px-2 ${
                        line.kind === 'add'
                          ? 'bg-emerald-500/10'
                          : line.kind === 'del'
                            ? 'bg-rose-500/10'
                            : ''
                      }`}
                    >
                      {lineNum ? (
                        <a
                          href={`vscode://file${absPathWithSlash}:${lineNum}`}
                          className={
                            'w-9 shrink-0 pr-2 text-right text-zinc-400 select-none hover:text-sky-500'
                          }
                          title={`Open ${file.path}:${lineNum} in VSCode`}
                        >
                          {lineNum}
                        </a>
                      ) : (
                        <span className="w-9 shrink-0 pr-2 text-right text-zinc-400 select-none">
                          {''}
                        </span>
                      )}
                      <span className="w-3 shrink-0 text-zinc-400 select-none">
                        {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                      </span>
                      <span className="whitespace-pre">{line.text}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
    </section>
  );
}
