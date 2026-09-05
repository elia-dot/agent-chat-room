import { useEffect } from 'react';

export interface OverlayProps {
  title: string;
  /** Shown in mono next to the title: the shortcut that opened it. */
  hint?: string;
  side?: 'right' | 'left' | 'center';
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * A sheet over the transcript.
 *
 * The design moves room facts, the roster and the action buttons off the permanent chrome
 * and behind a keystroke. Nothing here is needed while reading, and all of it was
 * previously competing with the conversation for the same screen.
 */
export function Overlay({
  title,
  hint,
  side = 'right',
  onClose,
  children,
}: OverlayProps): React.ReactElement {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const position =
    side === 'center'
      ? 'inset-x-0 top-[12vh] mx-auto max-w-2xl rounded-lg border'
      : side === 'left'
        ? 'inset-y-0 left-0 w-[420px] max-w-[92vw] border-r'
        : 'inset-y-0 right-0 w-[420px] max-w-[92vw] border-l';

  return (
    <div className="fixed inset-0 z-30">
      <button
        type="button"
        aria-label="close"
        onClick={onClose}
        className="absolute inset-0 bg-black/45"
      />
      <div
        className={`absolute flex max-h-[86vh] flex-col border-line bg-ground shadow-2xl ${position}`}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
          <h2 className="font-mono text-[11px] tracking-[0.14em] text-ink-dim uppercase">
            {title}
          </h2>
          {hint && <span className="font-mono text-[10px] text-ink-faint">{hint}</span>}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-line px-2 py-0.5 font-mono text-[10px] text-ink-faint hover:border-line-strong hover:text-ink"
          >
            esc
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

/** A labelled rule that opens a section, used to fence off the destructive actions. */
export function Divider({
  label,
  tone = 'quiet',
}: {
  label: string;
  tone?: 'quiet' | 'danger';
}): React.ReactElement {
  return (
    <div className="mt-4 flex items-center gap-2">
      <span className="h-px flex-1 bg-line" />
      <span
        className={`font-mono text-[10px] tracking-[0.12em] ${
          tone === 'danger' ? 'text-error' : 'text-ink-faint'
        }`}
      >
        {label}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/** One `label   value` row, the read side of the room overlay. */
export function Fact({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div className="flex gap-3 py-[3px] text-[12px]">
      <span className="w-20 shrink-0 font-mono text-[11px] text-ink-faint">{label}</span>
      <span className={`min-w-0 flex-1 break-words text-ink-soft ${mono ? 'font-mono' : ''}`}>
        {children}
      </span>
    </div>
  );
}
