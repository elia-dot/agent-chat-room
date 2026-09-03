/**
 * Incremental NDJSON line splitter.
 *
 * A CLI's stdout arrives in arbitrary chunks, so a JSON object is routinely split across
 * two `data` events. This buffers the tail until a newline shows up. It also refuses to
 * grow without bound: a runtime that streams a single enormous line (or, worse, binary)
 * would otherwise sit in memory forever.
 */
export class LineSplitter {
  private buf = '';
  private dropping = false;
  /** Number of over-long lines discarded, exposed so callers can log the fact. */
  droppedLines = 0;

  constructor(private readonly maxLineChars = 8 * 1024 * 1024) {}

  push(chunk: string): string[] {
    const out: string[] = [];
    let rest = chunk;

    while (rest.length > 0) {
      const nl = rest.indexOf('\n');
      if (nl === -1) {
        if (this.dropping) return out;
        this.buf += rest;
        if (this.buf.length > this.maxLineChars) {
          this.buf = '';
          this.dropping = true;
          this.droppedLines += 1;
        }
        return out;
      }
      const piece = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (this.dropping) {
        this.dropping = false;
        continue;
      }
      const line = (this.buf + piece).replace(/\r$/, '');
      this.buf = '';
      if (line.length > 0) out.push(line);
    }
    return out;
  }

  /** Emit whatever is left when the stream closes without a trailing newline. */
  flush(): string[] {
    if (this.dropping) {
      this.dropping = false;
      this.buf = '';
      return [];
    }
    const line = this.buf.replace(/\r$/, '');
    this.buf = '';
    return line.length > 0 ? [line] : [];
  }
}

/**
 * Parse a line as JSON, returning `undefined` instead of throwing.
 *
 * Every runtime eventually prints something that is not an event – a deprecation notice,
 * a progress bar, an npm warning. Skipping those is the difference between a working
 * adapter and one that dies on a version bump.
 */
export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed[0] !== '{') return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
