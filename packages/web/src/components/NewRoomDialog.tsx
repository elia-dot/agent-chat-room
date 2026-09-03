import type { RepoRecord, RoomMode, RuntimeReportEntry } from '@agent-chat-room/core';
import { useEffect, useState } from 'react';

import type { BrowseResult, CreateRoomRequest } from '../api/client.js';
import { api } from '../api/client.js';
import { basename } from '../lib/format.js';

export interface NewRoomDialogProps {
  onClose: () => void;
  onCreate: (input: CreateRoomRequest) => Promise<void>;
}

/**
 * PLAN.md section 5.5: repo picker (recent + browse), task, mode, roster as toggle cards in
 * worker-first order with a model each, max rounds, worktree.
 *
 * Order is the role: in a build-review room the first selected runtime is the worker and
 * every other one reviews; in a brainstorm the last one moderates. That is the same rule
 * `--agents` follows, so the dialog and the flag cannot disagree.
 */
export function NewRoomDialog({ onClose, onCreate }: NewRoomDialogProps): React.ReactElement {
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeReportEntry[]>([]);
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [browsing, setBrowsing] = useState(false);

  const [cwd, setCwd] = useState('');
  const [task, setTask] = useState('');
  const [title, setTitle] = useState('');
  const [agents, setAgents] = useState<string[]>([]);
  const [mode, setMode] = useState<RoomMode>('build-review');
  const [models, setModels] = useState<Record<string, string>>({});
  const [maxRounds, setMaxRounds] = useState(4);
  const [worktree, setWorktree] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const [recent, detected] = await Promise.all([
        api.repos().catch(() => []),
        api.runtimes().catch(() => ({ node: '', runtimes: [] })),
      ]);
      setRepos(recent);
      setRuntimes(detected.runtimes);
      // A usable roster by default, worker first, so the common case is one click.
      setAgents(
        detected.runtimes
          .filter((r) => r.usable)
          .slice(0, 2)
          .map((r) => r.id),
      );
      if (recent[0]) setCwd(recent[0].path);
    })();
  }, []);

  const toggle = (id: string): void => {
    setAgents((current) =>
      current.includes(id) ? current.filter((a) => a !== id) : [...current, id],
    );
  };

  const move = (id: string, delta: number): void => {
    setAgents((current) => {
      const index = current.indexOf(id);
      const target = index + delta;
      if (index === -1 || target < 0 || target >= current.length) return current;
      const next = [...current];
      next.splice(target, 0, next.splice(index, 1)[0]!);
      return next;
    });
  };

  const openBrowse = async (path?: string): Promise<void> => {
    setBrowsing(true);
    try {
      setBrowse(await api.browse(path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const submit = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const chosen: Record<string, string> = {};
      for (const id of agents) {
        const model = models[id]?.trim();
        if (model) chosen[id] = model;
      }
      await onCreate({
        task,
        cwd,
        agents,
        mode,
        worktree,
        start: true,
        // A brainstorm is three fixed phases, so a round budget would be meaningless.
        ...(mode === 'brainstorm' ? {} : { maxRounds }),
        ...(Object.keys(chosen).length > 0 ? { models: chosen } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const ready = cwd.trim() !== '' && task.trim() !== '' && agents.length >= 2;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6">
      <div className="w-full max-w-2xl rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="font-medium">New room</h2>
          <button type="button" onClick={onClose} className="text-sm text-zinc-500 hover:underline">
            cancel
          </button>
        </header>

        <div className="space-y-4 p-4">
          <Field label="Repo">
            <div className="flex gap-2">
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/Users/you/code/your-repo"
                className="flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
              <button
                type="button"
                onClick={() => void openBrowse(cwd || undefined)}
                className="rounded-md border border-zinc-300 px-3 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                browse
              </button>
            </div>

            {repos.length > 0 && !browsing && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {repos.slice(0, 6).map((repo) => (
                  <button
                    key={repo.path}
                    type="button"
                    onClick={() => setCwd(repo.path)}
                    title={repo.path}
                    className="rounded-full border border-zinc-300 px-2 py-0.5 text-[11px] hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    {basename(repo.path)}
                  </button>
                ))}
              </div>
            )}

            {browsing && browse && (
              <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-800">
                <div className="flex items-center justify-between border-b border-zinc-200 px-2 py-1 text-[11px] dark:border-zinc-800">
                  <span className="truncate font-mono">{browse.path}</span>
                  <span className="flex gap-2">
                    {browse.parent && (
                      <button
                        type="button"
                        onClick={() => void openBrowse(browse.parent ?? undefined)}
                        className="text-zinc-500 hover:underline"
                      >
                        up
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setBrowsing(false)}
                      className="text-zinc-500 hover:underline"
                    >
                      done
                    </button>
                  </span>
                </div>
                <ul>
                  {browse.entries.map((entry) => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        onClick={() => {
                          if (entry.isRepo) {
                            setCwd(entry.path);
                            setBrowsing(false);
                          } else {
                            void openBrowse(entry.path);
                          }
                        }}
                        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        <span className={entry.isRepo ? 'text-emerald-500' : 'text-zinc-400'}>
                          {entry.isRepo ? '◆' : '▸'}
                        </span>
                        <span className="truncate">{entry.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Field>

          <Field label="Task">
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={4}
              placeholder="The login test is flaky. Find out why and fix it."
              className="w-full resize-y rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
          </Field>

          <Field label="Mode">
            <div className="flex gap-2">
              {(['build-review', 'brainstorm'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setMode(option)}
                  className={`flex-1 rounded-md border px-3 py-2 text-left text-sm ${
                    mode === option
                      ? 'border-sky-500 bg-sky-500/5'
                      : 'border-zinc-200 dark:border-zinc-800'
                  }`}
                >
                  <span className="block font-medium">{option}</span>
                  <span className="block text-[11px] text-zinc-500">
                    {option === 'build-review'
                      ? 'one builds, the others review, repeat'
                      : 'everyone answers, everyone reacts, the last one merges'}
                  </span>
                </button>
              ))}
            </div>
          </Field>

          <Field
            label={
              mode === 'brainstorm'
                ? 'Roster – the last one moderates, nobody edits files'
                : 'Roster – the first one builds, the rest review'
            }
          >
            <ul className="space-y-1.5">
              {runtimes.map((runtime) => {
                const index = agents.indexOf(runtime.id);
                const on = index !== -1;
                return (
                  <li
                    key={runtime.id}
                    className={`flex items-center gap-2 rounded-md border px-2 py-1.5 ${
                      on
                        ? 'border-sky-500 bg-sky-500/5'
                        : 'border-zinc-200 opacity-70 dark:border-zinc-800'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!runtime.usable && !on}
                      onChange={() => toggle(runtime.id)}
                    />
                    <span className="flex-1 text-sm">
                      {runtime.displayName}
                      <span className="ml-2 text-[11px] text-zinc-500">
                        {runtime.installed
                          ? `v${runtime.version ?? '?'}${runtime.loggedIn === false ? ' · not logged in' : ''}`
                          : 'not installed'}
                      </span>
                    </span>
                    {on && (
                      <>
                        <input
                          value={models[runtime.id] ?? ''}
                          onChange={(e) =>
                            setModels((m) => ({ ...m, [runtime.id]: e.target.value }))
                          }
                          placeholder="model"
                          aria-label={`${runtime.id} model`}
                          className="w-32 rounded border border-zinc-300 bg-white px-1.5 py-px font-mono text-[11px] dark:border-zinc-700 dark:bg-zinc-950"
                        />
                        <span className="rounded bg-zinc-200 px-1.5 py-px text-[10px] dark:bg-zinc-800">
                          {roleFor(mode, index, agents.length)}
                        </span>
                        <button
                          type="button"
                          onClick={() => move(runtime.id, -1)}
                          disabled={index === 0}
                          className="px-1 text-xs disabled:opacity-30"
                          aria-label={`move ${runtime.id} up`}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() => move(runtime.id, 1)}
                          disabled={index === agents.length - 1}
                          className="px-1 text-xs disabled:opacity-30"
                          aria-label={`move ${runtime.id} down`}
                        >
                          ↓
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
            {agents.length < 2 && (
              <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                {mode === 'brainstorm'
                  ? 'A brainstorm needs at least two participants.'
                  : 'A room needs a worker and at least one reviewer.'}
              </p>
            )}
          </Field>

          <div className="flex flex-wrap items-end gap-4">
            <Field label="Title (optional)">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="the first line of the task"
                className="w-56 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
            </Field>
            {mode === 'build-review' && (
              <Field label="Max rounds">
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={maxRounds}
                  onChange={(e) => setMaxRounds(Number(e.target.value))}
                  className="w-20 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                />
              </Field>
            )}
            <label className="flex items-center gap-2 pb-1.5 text-sm">
              <input
                type="checkbox"
                checked={worktree}
                onChange={(e) => setWorktree(e.target.checked)}
              />
              run in a git worktree
            </label>
          </div>

          {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
        </div>

        <footer className="flex justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!ready || busy}
            className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
          >
            {busy ? 'Opening…' : 'Open room'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** The role a card gets from its position, which is the only thing that decides it. */
function roleFor(mode: RoomMode, index: number, total: number): string {
  if (mode === 'brainstorm') return index === total - 1 ? 'moderator' : 'participant';
  return index === 0 ? 'worker' : 'reviewer';
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-zinc-500">{label}</label>
      {children}
    </div>
  );
}
