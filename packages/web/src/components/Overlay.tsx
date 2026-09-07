import { useEffect, useId, useRef } from 'react';

export interface OverlayProps {
  title: string;
  /** Shown in mono next to the title: the shortcut that opened it. */
  hint?: string;
  side?: 'right' | 'left' | 'center';
  onClose: () => void;
  children: React.ReactNode;
}

/** What Tab can land on. Disabled controls and `tabindex="-1"` are deliberately excluded. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Trap Tab inside a container and hand focus back to whatever opened it.
 *
 * Shared by the two modal surfaces. Split into two effects on purpose: the keydown handler
 * has to see the latest `onClose`, which is an inline arrow at every call site and so has a
 * new identity every render, while the focus save/restore must run exactly once. Putting
 * them together would restore focus on every render.
 */
export function useModalFocus<T extends HTMLElement>(
  container: React.RefObject<T | null>,
  onClose: () => void,
): void {
  /*
   * Captured during the first render, which is the last moment `document.activeElement` is
   * still the control that opened this.
   *
   * An effect is too late. React implements `autoFocus` by calling `focus()` in the commit
   * phase, and passive effects run after that, so reading `activeElement` from an effect in
   * `RoomsOverlay` returns its own `autoFocus` filter box rather than the button behind it.
   * The overlay would then record a node inside itself as the opener and try to restore
   * focus to it after unmount, which silently drops focus to the body.
   */
  const opener = useRef<Element | null>(null);
  opener.current ??= document.activeElement;
  /** Whatever inside the panel held focus when this effect last tore down. */
  const inside = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const previous = inside.current?.isConnected === true ? inside.current : null;
    if (previous) {
      // A remount. StrictMode does one of these on every mount in development, and its
      // simulated teardown has already handed focus back to the opener; re-taking the panel
      // here is what would defeat `autoFocus` a second time.
      previous.focus();
    } else if (!node.contains(document.activeElement)) {
      // Only take focus if nothing inside already has it. `RoomsOverlay` autofocuses its
      // filter so you can type the moment ⌘K lands; moving focus to the panel would undo
      // exactly the thing that `autoFocus` is there for.
      node.focus();
    }
    return () => {
      const active = document.activeElement;
      inside.current = node.contains(active) && active instanceof HTMLElement ? active : null;
      const back = opener.current;
      // `isConnected` because the opener may itself have been unmounted while the overlay
      // was up – focusing a detached node does nothing and loses the caret to the body.
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, [container]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !container.current) return;
      const nodes = Array.from(container.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement;
      // Wrapping from the container itself covers the first Tab after it takes focus.
      if (event.shiftKey && (active === first || active === container.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [container, onClose]);
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
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useModalFocus(panel, onClose);

  const position =
    side === 'center'
      ? 'inset-x-0 top-[12vh] mx-auto max-w-2xl rounded-lg border'
      : side === 'left'
        ? 'inset-y-0 left-0 w-[420px] max-w-[92vw] border-r'
        : 'inset-y-0 right-0 w-[420px] max-w-[92vw] border-l';

  return (
    <div className="fixed inset-0 z-30">
      {/* Not a button: Escape and the `esc` control already close this, and a full-viewport
          tab stop labelled "close" only gets in the way of the trap below. */}
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-black/45" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`absolute flex max-h-[86vh] flex-col border-line bg-ground shadow-2xl ${position}`}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
          <h2
            id={titleId}
            className="font-mono text-[11px] tracking-[0.14em] text-ink-dim uppercase"
          >
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
