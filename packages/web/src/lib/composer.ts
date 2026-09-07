/**
 * The composer's auto-sizing arithmetic.
 *
 * Pure and exported so it can be unit-tested without a DOM: the component measures the
 * textarea and asks this how tall the box should be and whether the message has outgrown
 * one line, which is what decides where the attach and send buttons sit.
 */

/** One line of composer text, in pixels. Mirrored by `leading-[22px]` on the textarea. */
export const LINE = 22;

/** How tall the box is allowed to grow before a long draft scrolls instead. */
export const MAX_LINES = 6;

export interface ComposerBox {
  /** The height to write back onto the textarea, in pixels. */
  height: number;
  /** True once the content is taller than a single line: buttons drop to the bottom. */
  expanded: boolean;
}

/**
 * Turn a measured `scrollHeight` into the box's height and alignment.
 *
 * A `scrollHeight` of 0 means the element is not laid out yet (first paint, or a hidden
 * parent). Collapsing the box to nothing there would flash an empty sliver, so the
 * fallback is one line – the same height an empty composer settles at anyway.
 */
export function composerBox(scrollHeight: number): ComposerBox {
  const content = Number.isFinite(scrollHeight) && scrollHeight > 0 ? scrollHeight : LINE;
  return {
    height: Math.min(Math.max(content, LINE), LINE * MAX_LINES),
    expanded: content > LINE,
  };
}
