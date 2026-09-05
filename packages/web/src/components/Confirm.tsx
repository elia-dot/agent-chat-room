import { useEffect, useRef, useState } from 'react';

const HOLD_MS = 900;

/**
 * Hold to confirm.
 *
 * The design puts the destructive actions behind a labelled divider and then behind a
 * gesture, because "are you sure?" trains people to click yes. A press that has to be
 * sustained cannot be done by muscle memory, and the bar filling under the label says how
 * much longer without a dialog.
 */
export function HoldToConfirm({
  label,
  hint = 'hold to confirm',
  disabled = false,
  onConfirm,
}: {
  label: string;
  hint?: string;
  disabled?: boolean;
  onConfirm: () => void;
}): React.ReactElement {
  const [progress, setProgress] = useState(0);
  const frame = useRef<number | null>(null);
  const start = useRef(0);

  const stop = (): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    setProgress(0);
  };

  useEffect(() => stop, []);

  const begin = (): void => {
    if (disabled) return;
    start.current = performance.now();
    const tick = (): void => {
      const ratio = Math.min(1, (performance.now() - start.current) / HOLD_MS);
      setProgress(ratio);
      if (ratio >= 1) {
        stop();
        onConfirm();
        return;
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };

  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={begin}
      onPointerUp={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') begin();
      }}
      onKeyUp={stop}
      className="relative flex w-full items-center gap-2.5 overflow-hidden rounded px-1 py-1.5 text-left disabled:opacity-50"
    >
      <span className="text-[13.5px] text-changes">{label}</span>
      <span className="flex-1" />
      <span className="rounded border border-changes-line px-2 py-[3px] font-mono text-[10.5px] text-changes">
        {progress > 0 ? 'keep holding…' : hint}
      </span>
      <span
        className="absolute bottom-0 left-0 h-0.5 bg-changes transition-none"
        style={{ width: `${progress * 100}%` }}
      />
    </button>
  );
}

/**
 * Type the room's name to confirm.
 *
 * Reserved for purge, the one action that destroys work that is not recoverable from git.
 * Typing the name proves you know which room you are standing in, which a hold does not.
 */
export function TypeToConfirm({
  label,
  expect,
  disabled = false,
  onConfirm,
}: {
  label: string;
  expect: string;
  disabled?: boolean;
  onConfirm: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === expect.trim() && expect.trim().length > 0;

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2.5 rounded px-1 py-1.5 text-left disabled:opacity-50"
      >
        <span className="text-[13.5px] text-changes">{label}</span>
        <span className="flex-1" />
        <span className="rounded border border-changes-line px-2 py-[3px] font-mono text-[10.5px] text-changes">
          type room name
        </span>
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-1 py-1.5">
      <div className="flex items-center gap-2.5">
        <span className="text-[13.5px] text-changes">{label}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setTyped('');
          }}
          className="font-mono text-[10.5px] text-ink-faint hover:text-ink"
        >
          cancel
        </button>
      </div>
      <div className="flex gap-2">
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={expect}
          aria-label={`type ${expect} to confirm`}
          className="min-w-0 flex-1 rounded border border-changes-line bg-ground px-2 py-1 font-mono text-[11.5px] text-ink placeholder:text-ink-faint focus:outline-none"
        />
        <button
          type="button"
          disabled={!matches}
          onClick={() => {
            onConfirm();
            setOpen(false);
            setTyped('');
          }}
          className="rounded bg-changes px-3 py-1 font-mono text-[11px] text-ground disabled:opacity-40"
        >
          purge
        </button>
      </div>
    </div>
  );
}
