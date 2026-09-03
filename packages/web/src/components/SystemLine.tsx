/** A system line: round boundaries, approval counts, pauses, errors. */
export function SystemLine({ text }: { text: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-3 px-4 py-1.5">
      <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
      <span className="max-w-[70%] text-center text-[11px] whitespace-pre-wrap text-zinc-500">
        {text}
      </span>
      <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
    </div>
  );
}
