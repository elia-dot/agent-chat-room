import type { RuntimeReportEntry } from '@agent-chat-room/core';
import { useEffect, useState } from 'react';

import { api } from '../api/client.js';

/**
 * PLAN.md section 5.6. The same `runtimeReport()` payload `acr doctor --json` prints, so
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
          <h1 className="text-lg font-medium">Doctor</h1>
          <button type="button" onClick={onClose} className="text-sm text-zinc-500 hover:underline">
            back to rooms
          </button>
        </header>

        {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
        {!report && !error && <p className="text-sm text-zinc-500">detecting…</p>}

        {report && (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800">
                  <th className="py-1.5 font-medium">runtime</th>
                  <th className="font-medium">installed</th>
                  <th className="font-medium">version</th>
                  <th className="font-medium">min</th>
                  <th className="font-medium">login</th>
                  <th className="font-medium">note</th>
                </tr>
              </thead>
              <tbody>
                {report.runtimes.map((runtime) => (
                  <tr
                    key={runtime.id}
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
                  >
                    <td className="py-1.5">
                      {runtime.displayName}
                      <span className="ml-1.5 font-mono text-[11px] text-zinc-500">
                        {runtime.id}
                      </span>
                    </td>
                    <td>{runtime.installed ? 'yes' : 'no'}</td>
                    <td className="font-mono text-xs">{runtime.version ?? '–'}</td>
                    <td>{runtime.installed ? (runtime.minVersionOk ? 'ok' : 'too old') : '–'}</td>
                    <td>
                      {/* `undefined` is "this adapter cannot tell without spawning the CLI",
                          which detection never does. It is not the same as "no". */}
                      {runtime.loggedIn === undefined ? '?' : runtime.loggedIn ? 'yes' : 'no'}
                    </td>
                    <td className="text-xs text-zinc-500">{runtime.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="mt-4 text-xs text-zinc-500">node {report.node}</p>
            {usable < 2 && (
              <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">
                Only {usable} usable runtime{usable === 1 ? '' : 's'} detected. A room needs two:
                one to build and at least one to review. `acr` never reads your credentials – it
                only checks that each CLI has a login on disk.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
