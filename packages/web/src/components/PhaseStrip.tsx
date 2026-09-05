export interface Phase {
  /** 1, 2 or 3. */
  number: number;
  name: string;
  /** `4/4`, `9 notes`, `done` – what the phase produced. */
  detail: string;
  state: 'done' | 'running' | 'waiting';
}

export interface PhaseStripProps {
  phases: Phase[];
  moderator: string | null;
  age: string;
  participants: number;
  hasProposal: boolean;
  onJumpToProposal: () => void;
}

/**
 * A brainstorm has phases, not rounds.
 *
 * The round strip is the wrong instrument here: a brainstorm is exactly three steps with
 * fixed names, and it either reached the proposal or it did not. Naming the phases is more
 * useful than colouring a progress bar, because the question a person actually has is
 * "have they merged yet".
 */
export function PhaseStrip(props: PhaseStripProps): React.ReactElement {
  return (
    <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-sunken px-3.5">
      <span className="shrink-0 font-mono text-[10px] tracking-[0.12em] text-ink-faint">
        PHASES
      </span>

      <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
        {props.phases.map((phase) => (
          <span
            key={phase.number}
            className={`flex shrink-0 items-center gap-1.5 rounded-[3px] border px-2 py-1 font-mono text-[10px] ${
              phase.state === 'done'
                ? 'border-approve-line bg-approve-bg text-approve'
                : phase.state === 'running'
                  ? 'border-live-line bg-live-bg text-live'
                  : 'border-line bg-raised text-ink-faint'
            }`}
          >
            <span aria-hidden="true">
              {phase.state === 'done' ? '✓' : phase.state === 'running' ? '•' : '○'}
            </span>
            {phase.number} {phase.name.toUpperCase()}
            <span className="opacity-70">{phase.detail}</span>
          </span>
        ))}
      </div>

      <span className="shrink-0 font-mono text-[11px] text-ink-faint">
        {props.moderator ? `moderator ${props.moderator} · ` : ''}
        {props.age} · {props.participants} participants
      </span>

      <span className="flex-1" />

      {props.hasProposal && (
        <button
          type="button"
          onClick={props.onJumpToProposal}
          className="shrink-0 rounded border border-line px-2 py-[3px] font-mono text-[10px] text-ink-dim hover:border-line-strong hover:text-ink"
        >
          jump to proposal
        </button>
      )}
    </div>
  );
}

/**
 * Derive the three phases from the transcript.
 *
 * A brainstorm's round number *is* its phase, which is why this can be read off the
 * messages rather than asked for.
 */
export function phasesOf(
  messages: { kind: string; round: number }[],
  currentRound: number,
  live: boolean,
): Phase[] {
  const count = (round: number): number =>
    messages.filter((m) => m.kind === 'agent' && m.round === round).length;

  const names: [number, string, (n: number) => string][] = [
    [1, 'answer', (n) => `${n} answers`],
    [2, 'react', (n) => `${n} notes`],
    [3, 'merge', (n) => (n > 0 ? 'done' : '–')],
  ];

  return names.map(([number, name, detail]) => {
    const n = count(number);
    const state: Phase['state'] =
      n > 0 && (number < currentRound || !live)
        ? 'done'
        : number === currentRound
          ? 'running'
          : 'waiting';
    return {
      number,
      name,
      detail: detail(n),
      state: n === 0 && state === 'done' ? 'waiting' : state,
    };
  });
}
