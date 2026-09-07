import { useState } from 'react';

import type { DiffFile } from '../lib/diff.js';
import { parseUnifiedDiff } from '../lib/diff.js';

/**
 * The diff viewer in the room overlay.
 *
 * Unified rather than side-by-side: the overlay is 420px wide, and side-by-side in 420px is
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

  if (loading) return <p className="p-3 font-mono text-[11px] text-ink-faint">loading the diff…</p>;
  if (files.length === 0) {
    return (
      <p className="p-3 font-mono text-[11px] text-ink-faint">this message changed no files</p>
    );
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
    <section className="overflow-hidden rounded-md border border-line">
      <div className="flex w-full items-center gap-2 bg-raised px-2 py-1.5 text-left text-[11px]">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="shrink-0 text-ink-faint">{open ? '▾' : '▸'}</span>
          <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
            {file.status === 'rename' ? `${file.oldPath} → ${file.path}` : file.path}
          </span>
        </button>
        <div className="flex items-center gap-1 text-[10px] text-ink-faint">
          <a
            href={`cursor://file${absPathWithSlash}`}
            className="hover:text-live hover:underline"
            title="Open in Cursor"
          >
            cursor
          </a>
          <span>·</span>
          <a
            href={`vscode://file${absPathWithSlash}`}
            className="hover:text-live hover:underline"
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
          <span className="shrink-0 text-approve">+{file.additions}</span>
          <span className="shrink-0 text-error">−{file.deletions}</span>
        </button>
      </div>

      {open &&
        (file.binary ? (
          <p className="px-2 py-1.5 text-[11px] text-ink-faint">binary file</p>
        ) : (
          <div className="overflow-x-auto font-mono text-[11px] leading-relaxed">
            {file.hunks.map((hunk, i) => (
              <div key={i}>
                <div className="bg-live-bg px-2 text-live">{hunk.header}</div>
                {hunk.lines.map((line, j) => {
                  const lineNum = line.newLine ?? line.oldLine;
                  return (
                    <div
                      key={j}
                      className={`flex px-2 ${
                        line.kind === 'add'
                          ? 'bg-approve-bg'
                          : line.kind === 'del'
                            ? 'bg-error-bg'
                            : ''
                      }`}
                    >
                      {lineNum ? (
                        <a
                          href={`vscode://file${absPathWithSlash}:${lineNum}`}
                          className={
                            'w-9 shrink-0 pr-2 text-right text-ink-faint select-none hover:text-live'
                          }
                          title={`Open ${file.path}:${lineNum} in VSCode`}
                        >
                          {lineNum}
                        </a>
                      ) : (
                        <span className="w-9 shrink-0 pr-2 text-right text-ink-faint select-none">
                          {''}
                        </span>
                      )}
                      <span className="w-3 shrink-0 text-ink-faint select-none">
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
