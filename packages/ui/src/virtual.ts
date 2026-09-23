// The arithmetic of a virtual list: where each item starts, given the sizes
// known so far and an estimate for the rest, and which items a scroll
// position shows. Pure, so the window is testable without layout.

/** Where each item starts, and the total: `offsets[i]` is item i's top, `offsets[n]` the list's height. */
export function offsetsOf(sizes: readonly number[]): number[] {
  const out = new Array<number>(sizes.length + 1);
  out[0] = 0;
  for (let i = 0; i < sizes.length; i++) out[i + 1] = (out[i] as number) + (sizes[i] as number);
  return out;
}

/** The first item whose bottom is below `y` (binary search over the offsets). */
export function indexAt(offsets: readonly number[], y: number): number {
  const n = offsets.length - 1;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((offsets[mid + 1] as number) <= y) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, Math.max(0, n - 1));
}

export interface VirtualWindow {
  /** The first rendered item. */
  start: number;
  /** One past the last rendered item. */
  end: number;
  /** The space above the first rendered item. */
  before: number;
  /** The space below the last one. */
  after: number;
}

/**
 * The items to render for a view of `height` pixels scrolled to `top`
 * (both relative to the list's own start), plus `overscan` items on each
 * side.
 */
export function windowOf(
  offsets: readonly number[],
  top: number,
  height: number,
  overscan: number,
): VirtualWindow {
  const n = offsets.length - 1;
  if (n <= 0) return { start: 0, end: 0, before: 0, after: 0 };
  const first = indexAt(offsets, Math.max(0, top));
  const last = indexAt(offsets, Math.max(0, top + height - 1));
  const start = Math.max(0, first - overscan);
  const end = Math.min(n, last + 1 + overscan);
  const total = offsets[n] as number;
  return {
    start,
    end,
    before: offsets[start] as number,
    after: total - (offsets[end] as number),
  };
}

/**
 * The scroll position that brings the span [top, bottom) into a view of
 * `height` scrolled to `scroll`, moving as little as it can; `scroll` itself
 * when the span is already in view.
 */
export function scrollToReveal(scroll: number, height: number, top: number, bottom: number) {
  if (top < scroll) return top;
  if (bottom > scroll + height) return Math.min(top, bottom - height);
  return scroll;
}
