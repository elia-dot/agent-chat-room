/**
 * System lines, as bands rather than grey text.
 *
 * The design's "signal against noise" rule: a round closing, a commit landing, a PR opening
 * and a runtime failing are the four things a returning human scans for, and they used to
 * be the same 11px grey as everything else. Each now gets a bordered, tinted band with a
 * mono label on the left, so the outcome is readable from across the room and the rest of
 * the transcript stays quiet.
 */

type Kind = 'approved' | 'changes' | 'failure' | 'commit' | 'pr' | 'note';

interface Parsed {
  kind: Kind;
  /** The small capitalised label at the head of the band. */
  label: string;
  /** Everything else, rendered as-is. */
  detail: string;
}

const URL_RE = /https?:\/\/\S+/;

/**
 * Classify a system message by its text.
 *
 * The engine writes these as prose rather than typed events, so this reads them back. A
 * line it does not recognise falls through to a quiet note, which is the old behaviour and
 * the right default: inventing a colour for an unknown line is worse than not colouring it.
 */
export function classify(text: string): Parsed {
  const line = text.trim();

  const round = /^round (\d+): (\d+) of (\d+) approved/i.exec(line);
  if (round) {
    const [, n, got, total] = round;
    const all = got === total && got !== '0';
    return {
      kind: all ? 'approved' : 'changes',
      label: `ROUND ${n} · ${got} OF ${total} APPROVED`,
      detail: line.slice(round[0].length).replace(/^[.·\s]+/, ''),
    };
  }

  if (/^committed /i.test(line)) {
    return { kind: 'commit', label: 'COMMITTED', detail: line.replace(/^committed\s*/i, '') };
  }

  if (/^opened https?:/i.test(line)) {
    return { kind: 'pr', label: 'PR OPENED', detail: line.replace(/^opened\s*/i, '') };
  }

  if (/failed|could not|cannot|unauthorized|usage limit|timeout/i.test(line)) {
    return { kind: 'failure', label: 'FAILED', detail: line };
  }

  if (/^reopened by you/i.test(line)) {
    return { kind: 'note', label: 'REOPENED', detail: line.replace(/^reopened by you:\s*/i, '') };
  }

  const tagged = /^\[([a-z ]+)\]\s*/i.exec(line);
  if (tagged) {
    return {
      kind: 'note',
      label: tagged[1]!.toUpperCase(),
      detail: line.slice(tagged[0].length),
    };
  }

  return { kind: 'note', label: '', detail: line };
}

const BAND: Record<Kind, { wrap: string; label: string; rule: string }> = {
  approved: {
    wrap: 'border-approve-line bg-approve-bg',
    label: 'text-approve',
    rule: 'bg-approve-line',
  },
  changes: {
    wrap: 'border-changes-line bg-changes-bg',
    label: 'text-changes',
    rule: 'bg-changes-line',
  },
  failure: {
    wrap: 'border-changes-line bg-changes-bg',
    label: 'text-changes',
    rule: 'bg-changes-line',
  },
  commit: {
    wrap: 'border-approve-line bg-approve-bg',
    label: 'text-approve',
    rule: 'bg-approve-line',
  },
  pr: { wrap: 'border-line-strong bg-surface', label: 'text-ink-dim', rule: 'bg-line-strong' },
  note: { wrap: 'border-line bg-surface', label: 'text-ink-faint', rule: 'bg-line' },
};

export function SystemLine({ text, at }: { text: string; at?: string }): React.ReactElement {
  const { kind, label, detail } = classify(text);
  const band = BAND[kind];
  const url = URL_RE.exec(detail)?.[0];

  return (
    <div
      className={`flex items-start gap-2.5 rounded-md border px-3 py-2 font-mono text-[11.5px] ${band.wrap}`}
    >
      {label && (
        <>
          <span className={`shrink-0 pt-px text-[11px] tracking-[0.1em] ${band.label}`}>
            {label}
          </span>
          {detail && <span className={`mt-0.5 h-3.5 w-px shrink-0 ${band.rule}`} />}
        </>
      )}
      <span className="min-w-0 flex-1 whitespace-pre-wrap text-ink-soft">
        {url ? (
          <>
            {detail.slice(0, detail.indexOf(url))}
            <a href={url} target="_blank" rel="noreferrer" className="text-live hover:underline">
              {url}
            </a>
            {detail.slice(detail.indexOf(url) + url.length)}
          </>
        ) : (
          detail
        )}
      </span>
      {at && <span className="shrink-0 text-[11px] text-ink-faint">{at}</span>}
    </div>
  );
}

/**
 * The divider that opens a round in the transcript. Separate from the bands above because
 * it is navigation furniture, not an event: it carries the round number as an anchor the
 * round strip scrolls to.
 */
export function RoundDivider({
  round,
  summary,
  unit = 'round',
}: {
  round: number;
  summary?: string;
  /** A brainstorm counts phases, not rounds, and calling them rounds implies a loop. */
  unit?: 'round' | 'phase';
}): React.ReactElement {
  return (
    <div id={`round-${round}`} className="flex scroll-mt-4 items-center gap-2.5">
      <span className="rounded border border-line-strong bg-raised px-2.5 py-1 font-mono text-[10px] tracking-[0.14em] text-ink">
        {unit.toUpperCase()} {round}
      </span>
      {summary && <span className="font-mono text-[11px] text-ink-faint">{summary}</span>}
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
