import type { RoundOutcome, RoundSummary } from '../lib/rounds.js';

export interface RoundStripProps {
  rounds: RoundSummary[];
  current: number;
  /** `1 of 3 reviews in`, already worded by the caller. */
  progress: string;
  /** How long the room has been open, already formatted. */
  age: string;
  collapsed: boolean;
  onJump: (round: number) => void;
  onToggleCollapse: () => void;
}

const CELL: Record<RoundOutcome, string> = {
  approved: 'bg-approve-bg border-b-2 border-b-approve',
  changes: 'bg-changes-bg border-b-2 border-b-changes',
  question: 'bg-question-bg border-b-2 border-b-question',
  errored: 'bg-error-bg border-b-2 border-b-error',
  none: 'bg-raised border-b-2 border-b-line-strong',
  running: '',
};

/**
 * History as a strip, not a scrollbar.
 *
 * One cell per round, coloured by what the round came to, clickable to jump. A room that
 * has run 27 rounds is the case this exists for: the shape of the argument – four rounds
 * of changes, a question, then approval – is legible in a single glance, and getting back
 * to the round where things turned takes one click instead of a minute of scrolling.
 */
export function RoundStrip(props: RoundStripProps): React.ReactElement {
  return (
    <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-sunken px-3.5">
      <span className="shrink-0 font-mono text-[10px] tracking-[0.12em] text-ink-faint">
        ROUNDS
      </span>

      <div className="flex min-w-0 items-end gap-[3px] overflow-x-auto">
        {props.rounds.map((entry) =>
          entry.outcome === 'running' ? (
            <button
              key={entry.round}
              type="button"
              onClick={() => props.onJump(entry.round)}
              title={`round ${entry.round}, in flight`}
              className="relative flex h-[22px] w-[38px] shrink-0 items-center justify-center overflow-hidden rounded-[3px] border border-live-line bg-live-bg font-mono text-[10px] text-live"
            >
              r{entry.round}
              <span className="absolute bottom-0 left-0 h-0.5 w-1/3 bg-live acr-bar" />
            </button>
          ) : (
            <button
              key={entry.round}
              type="button"
              onClick={() => props.onJump(entry.round)}
              title={`round ${entry.round}: ${label(entry)}`}
              className={`h-4 w-[26px] shrink-0 rounded-[2px] ${CELL[entry.outcome]} ${
                entry.round === props.current ? 'ring-1 ring-line-strong' : ''
              }`}
            />
          ),
        )}
      </div>

      <span className="shrink-0 font-mono text-[11px] text-ink-faint">
        round {props.current}
        {props.progress ? ` · ${props.progress}` : ''}
        {props.age ? ` · ${props.age} in room` : ''}
      </span>

      <span className="flex-1" />

      <div className="hidden shrink-0 items-center gap-3 font-mono text-[10px] text-ink-faint xl:flex">
        <Key className="bg-changes">changes</Key>
        <Key className="bg-error">errored</Key>
        <Key className="bg-question">question</Key>
        <Key className="bg-approve">approved</Key>
      </div>

      <button
        type="button"
        onClick={props.onToggleCollapse}
        className="shrink-0 rounded border border-line px-2 py-[3px] font-mono text-[10px] text-ink-dim hover:border-line-strong hover:text-ink"
      >
        {props.collapsed ? 'expand all' : 'collapse all'}
      </button>
    </div>
  );
}

function Key({
  children,
  className,
}: {
  children: React.ReactNode;
  className: string;
}): React.ReactElement {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`size-2 rounded-[2px] ${className}`} />
      {children}
    </span>
  );
}

function label(entry: RoundSummary): string {
  if (entry.outcome === 'none') return 'no verdict';
  if (entry.outcome === 'approved') return `${entry.approvals} of ${entry.votes} approved`;
  return entry.outcome;
}
