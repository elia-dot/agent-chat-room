import { useEffect, useState } from 'react';

import type { AdditionalDir, AdditionalDirAccess } from '@agent-chat-room/core';

import { api } from '../api/client.js';
import { FolderPickerButton } from './FolderPickerButton.js';

export interface AdditionalDirsEditorProps {
  value: AdditionalDir[];
  onChange: (value: AdditionalDir[]) => void;
  disabled?: boolean;
}

const BLANK = { branch: null, baseBranch: null, prUrl: null };

/**
 * Edit the extra workspace roots granted to every runtime in a room.
 *
 * Access is the consequential half of this control, not the path: read & write means the
 * room will commit and open a pull request in a repository that is not its own, so each
 * row says which it is and the panel says what each one means.
 */
export function AdditionalDirsEditor({
  value,
  onChange,
  disabled,
}: AdditionalDirsEditorProps): React.ReactElement {
  const [draft, setDraft] = useState('');
  const [access, setAccess] = useState<AdditionalDirAccess>('write');
  const [nativePicker, setNativePicker] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .pickerStatus()
      .then((result) => setNativePicker(result.available))
      .catch(() => undefined);
  }, []);

  const add = (raw: string): void => {
    const path = raw.trim();
    if (!path) return;
    if (!value.some((dir) => dir.path === path)) onChange([...value, { path, access, ...BLANK }]);
    setDraft('');
    setError(null);
  };

  const setDirAccess = (path: string, next: AdditionalDirAccess): void =>
    onChange(value.map((dir) => (dir.path === path ? { ...dir, access: next } : dir)));

  const choose = async (): Promise<void> => {
    setPicking(true);
    setError(null);
    try {
      const result = await api.pickFolder(draft.trim() || value.at(-1)?.path);
      if (!('cancelled' in result)) add(result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <ul className="space-y-1">
          {value.map((dir) => (
            <li key={dir.path} className="flex min-w-0 items-center gap-1.5">
              <span
                className="min-w-0 flex-1 truncate rounded bg-raised px-2 py-1 font-mono text-[11px] text-ink"
                title={dir.path}
              >
                {dir.path}
              </span>
              <AccessToggle
                value={dir.access}
                disabled={disabled}
                onChange={(next) => setDirAccess(dir.path, next)}
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(value.filter((item) => item.path !== dir.path))}
                aria-label={`remove ${dir.path}`}
                className="rounded px-1.5 py-1 font-mono text-[11px] text-ink-faint hover:text-ink disabled:opacity-40"
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-1.5">
        <input
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            add(draft);
          }}
          placeholder="/absolute/path/to/folder"
          aria-label="additional folder"
          className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1.5 font-mono text-[11.5px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none disabled:opacity-40"
        />
        <AccessToggle value={access} disabled={disabled} onChange={setAccess} />
        <button
          type="button"
          disabled={disabled || !draft.trim()}
          onClick={() => add(draft)}
          className="rounded border border-line px-3 py-1.5 font-mono text-[11.5px] text-ink-dim hover:border-line-strong hover:text-ink disabled:opacity-40"
        >
          Add
        </button>
        {nativePicker && (
          <FolderPickerButton
            disabled={disabled || picking}
            onClick={() => void choose()}
            picking={picking}
            label="Choose additional folder"
          />
        )}
      </div>
      <p className="text-[11px] leading-snug text-ink-faint">
        <span className="font-mono">read</span> lets the agents open the files and nothing else – an
        edit there is reverted. <span className="font-mono">read & write</span> makes the folder
        part of the room: its changes join the diff the reviewers judge, the room commits them on a
        branch of its own, and Open PR opens a pull request there too.
      </p>
      {error && <p className="font-mono text-[11px] text-error">{error}</p>}
    </div>
  );
}

/** Two states, both always visible: which one is set has real consequences. */
function AccessToggle({
  value,
  disabled,
  onChange,
}: {
  value: AdditionalDirAccess;
  disabled?: boolean;
  onChange: (value: AdditionalDirAccess) => void;
}): React.ReactElement {
  return (
    <div className="flex shrink-0 overflow-hidden rounded border border-line">
      {(['read', 'write'] as const).map((option) => (
        <button
          key={option}
          type="button"
          disabled={disabled}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          title={
            option === 'read'
              ? 'read only: edits made here are reverted'
              : 'read & write: committed and opened as a PR with the room'
          }
          className={`px-2 py-1.5 font-mono text-[10.5px] disabled:opacity-40 ${
            value === option ? 'bg-raised text-ink' : 'text-ink-faint hover:text-ink'
          }`}
        >
          {option === 'read' ? 'read' : 'read & write'}
        </button>
      ))}
    </div>
  );
}
