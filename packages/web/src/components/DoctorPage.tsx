import type { RuntimeReportEntry } from '@agent-chat-room/core';
import { useEffect, useState } from 'react';

import { api } from '../api/client.js';

/**
 * The browser's doctor view: the same `runtimeReport()` payload `acr doctor --json` prints, so
 * the browser and the terminal can never disagree about which runtimes you have.
 */
export function DoctorPage({ onClose }: { onClose: () => void }): React.ReactElement {
  const [report, setReport] = useState<{ node: string; runtimes: RuntimeReportEntry[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .runtimes()
      .then(setReport)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const usable = report?.runtimes.filter((r) => r.usable).length ?? 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl p-6">
        <header className="mb-4 flex items-center justify-between">
          <h1 className="font-mono text-[11px] tracking-[0.14em] text-ink-dim uppercase">Doctor</h1>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-line px-2 py-0.5 font-mono text-[11px] text-ink-dim hover:border-line-strong hover:text-ink"
          >
            back to rooms
          </button>
        </header>

        {error && <p className="text-[13px] text-error">{error}</p>}
        {!report && !error && <p className="font-mono text-[11px] text-ink-faint">detecting…</p>}

        {report && (
          <>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left font-mono text-[10px] tracking-[0.12em] text-ink-faint">
                  <th className="py-1.5 font-normal">RUNTIME</th>
                  <th className="font-normal">INSTALLED</th>
                  <th className="font-normal">VERSION</th>
                  <th className="font-normal">MIN</th>
                  <th className="font-normal">LOGIN</th>
                  <th className="font-normal">NOTE</th>
                </tr>
              </thead>
              <tbody>
                {report.runtimes.map((runtime) => (
                  <tr key={runtime.id} className="border-b border-line last:border-0">
                    <td className="py-1.5">
                      {runtime.displayName}
                      <span className="ml-1.5 font-mono text-[11px] text-ink-faint">
                        {runtime.id}
                      </span>
                    </td>
                    <td>{runtime.installed ? 'yes' : 'no'}</td>
                    <td className="font-mono text-[11px]">{runtime.version ?? '–'}</td>
                    <td>{runtime.installed ? (runtime.minVersionOk ? 'ok' : 'too old') : '–'}</td>
                    <td>
                      {/* `undefined` is "this adapter cannot tell without spawning the CLI",
                          which detection never does. It is not the same as "no". */}
                      {runtime.loggedIn === undefined ? '?' : runtime.loggedIn ? 'yes' : 'no'}
                    </td>
                    <td className="text-[11px] text-ink-faint">{runtime.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="mt-4 font-mono text-[11px] text-ink-faint">node {report.node}</p>
            {usable < 2 && (
              <p className="mt-2 text-[13px] text-question">
                Only {usable} usable runtime{usable === 1 ? '' : 's'} detected. A room needs two:
                one to build and at least one to review. <span className="font-mono">acr</span>{' '}
                never reads your credentials – it only checks that each CLI has a login on disk.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
