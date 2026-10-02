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

/**
 * Whether a menu opens as a sheet along the bottom instead of beside its
 * button: in the phone form (data-form="phone" on the root, set by the shell
 * under appearance.mobile_breakpoint), where an anchored menu would cover
 * what it belongs to or run off the screen.
 */
export function opensAsSheet(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.form === "phone";
}

export interface AnchoredStyle {
  top?: number;
  left?: number;
  minWidth?: number;
  visibility?: "hidden";
}

/**
 * The inline position of an anchored menu: its placement, hidden until
 * measured so it never flashes at the wrong spot; nothing as a sheet, which
 * the stylesheet puts along the bottom.
 */
export function anchoredStyle(
  place: Placement | null,
  sheet: boolean,
  minWidth?: number,
): AnchoredStyle {
  if (sheet) return {};
  const style: AnchoredStyle = { top: place?.top ?? 0, left: place?.left ?? 0 };
  if (minWidth) style.minWidth = minWidth;
  if (!place) style.visibility = "hidden";
  return style;
}
