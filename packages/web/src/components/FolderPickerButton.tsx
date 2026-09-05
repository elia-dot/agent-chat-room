export interface FolderPickerButtonProps {
  onClick: () => void;
  disabled?: boolean;
  picking?: boolean;
  label?: string;
}

/** The one folder-picker affordance used anywhere a room accepts a directory. */
export function FolderPickerButton({
  onClick,
  disabled,
  picking,
  label = 'Choose folder',
}: FolderPickerButtonProps): React.ReactElement {
  const accessibleLabel = picking ? 'Choosing folder…' : label;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || picking}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      className={`flex size-8 shrink-0 items-center justify-center rounded-md border border-zinc-300 text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 ${
        picking ? 'animate-pulse' : ''
      }`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-4"
      >
        <path d="M3.5 6.75A1.75 1.75 0 0 1 5.25 5h4l2 2h7.5a1.75 1.75 0 0 1 1.75 1.75v8.5A1.75 1.75 0 0 1 18.75 19H5.25a1.75 1.75 0 0 1-1.75-1.75z" />
      </svg>
    </button>
  );
}
