// Where an anchored menu goes: below its button when it fits, above when only
// that fits, else on the roomier side; aligned to the button's start or end
// and kept inside the window. Pure, so the flip is testable without a layout.

export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface Placement {
  top: number;
  left: number;
  /** Opened above the button (no room below). */
  above: boolean;
}

/** Room kept between the menu and the window edge. */
const EDGE = 8;

/**
 * Where a menu of `size` goes for a button at `anchor` in a `viewport`: below
 * with `gap` when it fits, above when only that fits, else on the roomier
 * side. Aligned to the button's start (or end), kept inside the window.
 */
export function placeMenu(
  anchor: Rect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  options: { gap?: number; align?: "start" | "end" } = {},
): Placement {
  const gap = options.gap ?? 6;
  const below = viewport.height - anchor.bottom - gap - EDGE;
  const aboveRoom = anchor.top - gap - EDGE;
  const above = size.height > below && (size.height <= aboveRoom || aboveRoom > below);
  const top = above
    ? Math.max(EDGE, anchor.top - gap - size.height)
    : Math.min(anchor.bottom + gap, Math.max(EDGE, viewport.height - EDGE - size.height));
  const wanted = options.align === "end" ? anchor.right - size.width : anchor.left;
  const left = Math.min(Math.max(EDGE, wanted), Math.max(EDGE, viewport.width - EDGE - size.width));
  return { top, left, above };
}
