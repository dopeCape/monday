// The software keyboard on a phone. Android's webview shrinks the page for it
// (index.html asks for interactive-widget=resizes-content); iOS lays it over
// the page instead, so a field at the bottom (the agent bar, compose's foot,
// a reply) would sit under it. The visual viewport says how much the keyboard
// covers; the root carries it as --keyboard, which the phone stylesheet adds
// to what sits along the bottom. No React here.

/** How much of the layout viewport the keyboard covers, in CSS pixels; 0 when it is down. */
export function keyboardInset(
  layoutHeight: number,
  visual: { height: number; offsetTop: number } | null,
): number {
  if (!visual) return 0;
  const covered = Math.round(layoutHeight - visual.height - visual.offsetTop);
  // A sliver is the browser's own chrome settling, not a keyboard.
  return covered > 40 ? covered : 0;
}

/**
 * Keeps --keyboard on `root` up to date while the visual viewport moves.
 * Returns the stop.
 */
export function watchKeyboard(root: HTMLElement, win: Window = window): () => void {
  const vv = win.visualViewport;
  if (!vv) return () => {};
  const update = () => {
    const inset = keyboardInset(win.innerHeight, vv);
    if (inset > 0) root.style.setProperty("--keyboard", `${inset}px`);
    else root.style.removeProperty("--keyboard");
  };
  update();
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  return () => {
    vv.removeEventListener("resize", update);
    vv.removeEventListener("scroll", update);
    root.style.removeProperty("--keyboard");
  };
}
