import type {
  AdditionalDir,
  ModelCatalog,
  RepoRecord,
  RoomMode,
  RuntimeReportEntry,
} from '@agent-chat-room/core';
import { useEffect, useState } from 'react';

import type { CreateRoomRequest } from '../api/client.js';
import { api } from '../api/client.js';
import { agentTints, basename, dirname, initials, relativeTime, tintOf } from '../lib/format.js';
import { byRuntime } from '../lib/models.js';
import { filterRepos } from '../lib/repos.js';
import { AdditionalDirsEditor } from './AdditionalDirsEditor.js';
import { FolderPickerButton } from './FolderPickerButton.js';
import { ModelSelect } from './ModelSelect.js';
import { Divider } from './Overlay.js';

/** Enough recents to cover a normal week of projects; past that, filter instead of scroll. */
const RECENT_LIMIT = 8;

export interface NewRoomDialogProps {
  onClose: () => void;
  onCreate: (input: CreateRoomRequest) => Promise<void>;
}

/**
 * The new-room dialog, as the design's one-screen form.
 *
 * The roster is a table with a role per row rather than checkboxes plus reorder arrows.
 * Order is still what decides the role – the first runtime builds, the last one moderates –
 * but nobody should have to know that: picking "worker" moves it to the front, and the
 * access column shows what that choice actually grants the process.
 */
export function NewRoomDialog({ onClose, onCreate }: NewRoomDialogProps): React.ReactElement {
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeReportEntry[]>([]);
  const [catalogs, setCatalogs] = useState<Record<string, ModelCatalog>>({});
  const [nativePicker, setNativePicker] = useState(false);
  const [picking, setPicking] = useState(false);
  const [repoQuery, setRepoQuery] = useState('');
  /** What the pick told us about the folder: not a repo, or a repo whose root is elsewhere. */
  const [repoHint, setRepoHint] = useState<{ text: string; useRoot?: string } | null>(null);

  const [cwd, setCwd] = useState('');
  const [additionalDirs, setAdditionalDirs] = useState<AdditionalDir[]>([]);
  const [showFolders, setShowFolders] = useState(false);
  const [task, setTask] = useState('');
  const [title, setTitle] = useState('');
  const [agents, setAgents] = useState<string[]>([]);
  const [mode, setMode] = useState<RoomMode>('build-review');
  const [models, setModels] = useState<Record<string, string>>({});
  const [worktree, setWorktree] = useState(false);
  const [maxTurnRetries, setMaxTurnRetries] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const [recent, detected, picker, catalog] = await Promise.all([
        api.repos(20).catch(() => []),
        api.runtimes().catch(() => ({ node: '', runtimes: [] })),
        // An older server, or a headless one, keeps manual entry and recent projects.
        api.pickerStatus().catch(() => ({ available: false, tool: null })),
        // Listing models can reach the network, so it is the call most likely to fail –
        // and the least allowed to stop the dialog opening. No catalog means the picker
        // offers `default` and `Custom…`, which is still better than a bare text box.
        api.modelCatalogs().catch(() => ({ catalogs: [] })),
      ]);
      setRepos(recent);
      setRuntimes(detected.runtimes);
      setNativePicker(picker.available);
      setCatalogs(byRuntime(catalog.catalogs));
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

  /**
   * Position is the role, so setting a role is a move.
   *
   * Build-review: the front of the list builds. Brainstorm: the back of it merges.
   */
  const setRole = (id: string, role: string): void => {
    setAgents((current) => {
      const without = current.filter((a) => a !== id);
      if (role === 'off') return without;
      const toFront =
        (mode === 'build-review' && role === 'worker') ||
        (mode === 'brainstorm' && role === 'participant');
      return toFront ? [id, ...without] : [...without, id];
    });
  };

  const choose = (path: string): void => {
    setCwd(path);
    setRepoHint(null);
    setError(null);
  };

  /**
   * The native dialog opens on the machine running the server – which for `acr serve` is
   * this one – because only that machine can name an absolute path the agents can `cd` to.
   */
  const openNativePicker = async (): Promise<void> => {
    setPicking(true);
    try {
      const result = await api.pickFolder(cwd.trim() || undefined);
      if ('cancelled' in result) return;
      choose(result.path);
      // Caught here rather than at submit, where the room creation would just fail.
      if (!result.repoRoot) {
        setRepoHint({ text: 'That folder is not inside a git repository.' });
      } else if (result.repoRoot !== result.path) {
        setRepoHint({
          text: `That is inside the repo at ${result.repoRoot}.`,
          useRoot: result.repoRoot,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPicking(false);
    }
  };

  const ready = cwd.trim() !== '' && task.trim() !== '' && agents.length >= 2;

  const submit = async (): Promise<void> => {
    if (!ready || busy) return;
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
        ...(additionalDirs.length > 0 ? { additionalDirs } : {}),
        agents,
        mode,
        worktree,
        start: true,
        ...(Object.keys(chosen).length > 0 ? { models: chosen } : {}),
        ...(maxTurnRetries > 0 ? { maxTurnRetries } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        void submit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const shown = filterRepos(repos, repoQuery).slice(0, RECENT_LIMIT);
  const tints = agentTints(agents);
  const workers = mode === 'build-review' ? Math.min(agents.length, 1) : 0;
  const rest = agents.length - workers;
  // Without a title the branch is named by the worker runtime at creation time, so the
  // only honest preview is that it will be named from the task.
  const branchHint = title.trim() ? `acr/${slugify(title.trim())}` : 'acr/<named from your task>';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-6">
      <div className="w-full max-w-3xl overflow-hidden rounded-lg border border-line bg-ground shadow-2xl">
        <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
          <h2 className="font-mono text-[11px] tracking-[0.14em] text-ink-dim">NEW ROOM</h2>
          <div className="flex overflow-hidden rounded border border-line">
            {(['build-review', 'brainstorm'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                className={`px-2.5 py-1 font-mono text-[11px] ${
                  mode === option ? 'bg-ink text-ground' : 'text-ink-dim hover:text-ink'
                }`}
              >
                {option === 'build-review' ? 'build' : 'brainstorm'}
              </button>
            ))}
          </div>
          <span className="font-mono text-[11px] text-ink-faint">
            {mode === 'build-review'
              ? 'one builds, the others review, repeat'
              : 'everyone answers, everyone reacts, the last one merges'}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-line px-2 py-0.5 font-mono text-[10px] text-ink-faint hover:border-line-strong hover:text-ink"
          >
            esc
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto px-4 pb-4">
          <Divider label="REPO" />
          <div className="mt-2 flex gap-2">
            <input
              value={cwd}
              onChange={(e) => {
                setCwd(e.target.value);
                setRepoHint(null);
              }}
              placeholder="/Users/you/code/your-repo"
              className="min-w-0 flex-1 rounded border border-line bg-surface px-2.5 py-1.5 font-mono text-[12.5px] placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
            />
            {nativePicker && (
              <FolderPickerButton
                onClick={() => void openNativePicker()}
                disabled={picking}
                picking={picking}
                label="Choose repository folder"
              />
            )}
          </div>

          {repoHint && (
            <p className="mt-1.5 font-mono text-[11px] text-question">
              {repoHint.text}
              {repoHint.useRoot && (
                <button
                  type="button"
                  onClick={() => choose(repoHint.useRoot!)}
                  className="ml-1.5 underline"
                >
                  use the repo root
                </button>
              )}
            </p>
          )}

          <div className="mt-2.5 flex items-center justify-between">
            <span className="font-mono text-[10px] tracking-[0.12em] text-ink-faint">RECENT</span>
            {repos.length > RECENT_LIMIT && (
              <input
                value={repoQuery}
                onChange={(e) => setRepoQuery(e.target.value)}
                placeholder="filter"
                aria-label="filter recent projects"
                className="w-32 rounded border border-line bg-surface px-1.5 py-px font-mono text-[11px]"
              />
            )}
          </div>
          {shown.length === 0 ? (
            <p className="mt-1.5 font-mono text-[11px] text-ink-faint">
              {repos.length === 0
                ? 'nothing yet – the folders you open rooms on show up here'
                : 'no recent project matches that'}
            </p>
          ) : (
            <ul className="mt-1.5 overflow-hidden rounded border border-line">
              {shown.map((repo) => (
                <li key={repo.path} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => choose(repo.path)}
                    title={repo.path}
                    className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left ${
                      repo.path === cwd.trim() ? 'bg-live-bg' : 'hover:bg-surface'
                    }`}
                  >
                    <span className="truncate text-[13px] text-ink">{basename(repo.path)}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
                      {dirname(repo.path)}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                      {relativeTime(repo.lastUsedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* A second repository is a property of the workspace the room opens on, so it
              belongs with the folder it extends rather than three sections further down. */}
          <button
            type="button"
            onClick={() => setShowFolders((v) => !v)}
            aria-expanded={showFolders}
            className="mt-2.5 flex w-full items-center gap-2 rounded border border-line px-2.5 py-1.5 text-left hover:border-line-strong"
          >
            <span className="font-mono text-[11.5px] text-ink-dim">
              {showFolders ? '▾' : '+'} grant additional folders
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
              {additionalDirs.length === 0
                ? 'other repositories this room may read, or work in'
                : additionalDirs
                    .map(
                      (dir) =>
                        `${basename(dir.path)} · ${dir.access === 'read' ? 'read' : 'read & write'}`,
                    )
                    .join(', ')}
            </span>
            {additionalDirs.length > 0 && (
              <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                {additionalDirs.length}
              </span>
            )}
          </button>
          {showFolders && (
            <div className="mt-2">
              <AdditionalDirsEditor value={additionalDirs} onChange={setAdditionalDirs} />
            </div>
          )}

          <Divider label="TASK" />
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={4}
            placeholder="The login test is flaky. Find out why and fix it."
            className="mt-2 w-full resize-y rounded border border-line bg-surface px-2.5 py-2 text-[14px] placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-ink-faint">markdown ok</span>
            <span className="flex-1" />
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="title (optional)"
              aria-label="room title"
              className="w-56 rounded border border-line bg-surface px-2 py-1 font-mono text-[11.5px] placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
            />
          </div>

          <Divider label="ROSTER" />
          <p className="mt-1.5 font-mono text-[11px] text-ink-faint">
            {mode === 'build-review'
              ? 'worker first · reviewers vote each round'
              : 'the moderator merges · nobody edits files'}
          </p>

          <table className="mt-2 w-full">
            <thead>
              <tr className="font-mono text-[10px] tracking-[0.12em] text-ink-faint">
                <th className="px-2 py-1 text-left font-normal">AGENT</th>
                <th className="px-2 py-1 text-left font-normal">ROLE</th>
                <th className="px-2 py-1 text-left font-normal">MODEL</th>
                <th className="px-2 py-1 text-left font-normal">ACCESS</th>
              </tr>
            </thead>
            <tbody>
              {runtimes.map((runtime) => {
                const index = agents.indexOf(runtime.id);
                const on = index !== -1;
                const role = on ? roleFor(mode, index, agents.length) : 'off';
                const tone = tintOf(tints[runtime.id]);
                return (
                  <tr key={runtime.id} className={`border-t border-line ${on ? '' : 'opacity-55'}`}>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`flex size-6 items-center justify-center rounded-[5px] border bg-raised font-mono text-[9px] ${
                            on ? `${tone.border} ${tone.text}` : 'border-line text-ink-faint'
                          }`}
                        >
                          {initials(runtime.id)}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-mono text-[12px] text-ink">
                            {runtime.displayName}
                          </span>
                          <span className="block truncate font-mono text-[10.5px] text-ink-faint">
                            {runtime.installed
                              ? `v${runtime.version ?? '?'}${runtime.loggedIn === false ? ' · not logged in' : ''}`
                              : 'not installed'}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <select
                        value={role}
                        disabled={!runtime.usable && !on}
                        aria-label={`${runtime.id} role`}
                        onChange={(e) => setRole(runtime.id, e.target.value)}
                        className="rounded border border-line bg-surface px-1.5 py-1 font-mono text-[11px] uppercase disabled:opacity-50"
                      >
                        {rolesFor(mode).map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-2">
                      {on ? (
                        <ModelSelect
                          runtime={runtime.id}
                          value={models[runtime.id] ?? ''}
                          catalog={catalogs[runtime.id]}
                          className="w-44"
                          onChange={(value) => setModels((m) => ({ ...m, [runtime.id]: value }))}
                        />
                      ) : (
                        <span className="font-mono text-[11px] text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <span
                        className={`rounded px-1.5 py-px font-mono text-[10px] tracking-[0.08em] ${
                          role === 'worker'
                            ? 'bg-question-bg text-question'
                            : on
                              ? 'bg-raised text-ink-dim'
                              : 'text-ink-faint'
                        }`}
                      >
                        {access(mode, role)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {agents.length < 2 && (
            <p className="mt-2 font-mono text-[11px] text-question">
              {mode === 'brainstorm'
                ? 'a brainstorm needs at least two participants'
                : 'a room needs a worker and at least one reviewer'}
            </p>
          )}

          <Divider label="WORKSPACE" />
          <label className="mt-2 flex items-start gap-2.5">
            <input
              type="checkbox"
              checked={worktree}
              onChange={(e) => setWorktree(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-[13.5px] text-ink">Work in an isolated git worktree</span>
              <span
                className={`block font-mono text-[11px] ${worktree ? 'text-question' : 'text-ink-faint'}`}
              >
                {worktree
                  ? `isolated branch ${branchHint} · fresh worktrees have no dependencies or build artifacts, so tests and project commands may fail until setup installs or builds them`
                  : 'default · agents use your main checkout, including its installed dependencies and build artifacts'}
              </span>
            </span>
          </label>

          <Divider label="WHEN A TURN FAILS" />
          <label className="mt-2 flex items-start gap-2.5">
            <select
              value={maxTurnRetries}
              onChange={(e) => setMaxTurnRetries(Number(e.target.value))}
              className="mt-0.5 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[11.5px] text-ink"
            >
              {[0, 1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? 'never retry' : `retry ${n}×`}
                </option>
              ))}
            </select>
            <span>
              <span className="block text-[13.5px] text-ink">Retry a failed turn</span>
              <span
                className={`block font-mono text-[11px] ${maxTurnRetries > 0 ? 'text-question' : 'text-ink-faint'}`}
              >
                {maxTurnRetries > 0
                  ? `a turn that fails is run again up to ${maxTurnRetries} time${maxTurnRetries === 1 ? '' : 's'} before the room asks you · costs another turn each time, and a turn you stop yourself is never retried`
                  : 'default · the first failure hands the room back to you'}
              </span>
            </span>
          </label>

          {error && (
            <p className="mt-3 rounded border border-error-line bg-error-bg px-3 py-2 font-mono text-[11.5px] text-error">
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-line bg-surface px-4 py-3">
          <span className="min-w-0 flex-1 font-mono text-[11px] text-ink-faint">
            {mode === 'build-review'
              ? `${workers} worker · ${rest} reviewer${rest === 1 ? '' : 's'} · unanimous approval commits the round`
              : `${agents.length} participants · three phases · the last one merges`}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-line px-3 py-1.5 font-mono text-[11.5px] text-ink-dim hover:border-line-strong hover:text-ink"
          >
            cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!ready || busy}
            className="rounded bg-ink px-3.5 py-1.5 font-mono text-[11.5px] text-ground disabled:opacity-40"
          >
            {busy ? 'opening…' : 'create & run'} <span className="opacity-60">⌘↵</span>
          </button>
        </footer>
      </div>
    </div>
  );
}

/** The role a row gets from its position, which is the only thing that decides it. */
function roleFor(mode: RoomMode, index: number, total: number): string {
  if (mode === 'brainstorm') return index === total - 1 ? 'moderator' : 'participant';
  return index === 0 ? 'worker' : 'reviewer';
}

function rolesFor(mode: RoomMode): string[] {
  return mode === 'brainstorm'
    ? ['participant', 'moderator', 'off']
    : ['worker', 'reviewer', 'off'];
}

/** What the role actually grants the spawned process – the thing worth showing. */
function access(mode: RoomMode, role: string): string {
  if (role === 'off') return '—';
  if (mode === 'brainstorm') return 'READ';
  return role === 'worker' ? 'EDITS' : 'READ';
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'room'
  );
}
