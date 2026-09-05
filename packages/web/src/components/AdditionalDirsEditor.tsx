import { useEffect, useState } from 'react';

import { api } from '../api/client.js';
import { FolderPickerButton } from './FolderPickerButton.js';

export interface AdditionalDirsEditorProps {
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}

/** Edit the extra workspace roots granted to every runtime in a room. */
export function AdditionalDirsEditor({
  value,
  onChange,
  disabled,
}: AdditionalDirsEditorProps): React.ReactElement {
  const [draft, setDraft] = useState('');
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
    if (!value.includes(path)) onChange([...value, path]);
    setDraft('');
    setError(null);
  };

  const choose = async (): Promise<void> => {
    setPicking(true);
    setError(null);
    try {
      const result = await api.pickFolder(draft.trim() || value.at(-1));
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
          {value.map((path) => (
            <li key={path} className="flex min-w-0 items-center gap-1.5">
              <span
                className="min-w-0 flex-1 truncate rounded bg-zinc-100 px-2 py-1 font-mono text-[11px] dark:bg-zinc-800"
                title={path}
              >
                {path}
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(value.filter((item) => item !== path))}
                aria-label={`remove ${path}`}
                className="rounded px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800"
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
          className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-[11px] disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-950"
        />
        <button
          type="button"
          disabled={disabled || !draft.trim()}
          onClick={() => add(draft)}
          className="rounded border border-zinc-300 px-2 py-1 text-xs disabled:opacity-40 dark:border-zinc-700"
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
      {error && <p className="text-[11px] text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  );
}
