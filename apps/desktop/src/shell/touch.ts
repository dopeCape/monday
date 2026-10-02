// Touch on the Thread list in the phone form: a swipe across a row runs the
// action its direction names (inbox.swipe.right, inbox.swipe.left), a press
// held on a row starts a selection (inbox.long_press_ms), and a pull down
// from the top of the list syncs (inbox.pull_refresh_px). One set of
// listeners on the list, not one per row, so the virtual list's rows stay as
// they are; a row is found by its data-thread.

import { type RefObject, useEffect, useRef, useState } from "react";

export type SwipeDirection = "left" | "right";

export type PullState = "idle" | "pulling" | "ready" | "syncing";

export interface ListGestureOptions {
  enabled: boolean;
  /** Pixels a row travels before a swipe acts. */
  distance: number;
  /** Milliseconds a press rests before it starts a selection. */
  longPressMs: number;
  /** Pixels the list is pulled before a release syncs. */
  pullPx: number;
  onSwipe(threadId: string, direction: SwipeDirection): void;
  onLongPress(threadId: string): void;
  /** The pull's sync; absent, the list does not pull. */
  onPull?: (() => Promise<unknown>) | undefined;
}

/** A move this small is still a tap or a press. */
const SLOP = 10;
/** The pull follows the finger at this fraction, so it feels held back. */
const PULL_RESISTANCE = 0.5;

/** What a move so far means: not yet known, a row's swipe, a scroll, or a pull. */
type Mode = "pending" | "swipe" | "scroll" | "pull";

/** Decides a gesture from its first clear move; null while it is still within the slop. */
export function classifyMove(
  dx: number,
  dy: number,
  atTop: boolean,
): Exclude<Mode, "pending"> | null {
  if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return null;
  if (Math.abs(dx) > Math.abs(dy)) return "swipe";
  return atTop && dy > 0 ? "pull" : "scroll";
}

/** The swipe's direction once it has travelled far enough, else null. */
export function swipeOutcome(dx: number, distance: number): SwipeDirection | null {
  if (Math.abs(dx) < distance) return null;
  return dx > 0 ? "right" : "left";
}

function rowOf(target: EventTarget | null, root: HTMLElement): HTMLElement | null {
  const el = target instanceof Element ? target.closest<HTMLElement>(".row[data-thread]") : null;
  return el && root.contains(el) ? el : null;
}

function clearRow(row: HTMLElement | null) {
  if (!row) return;
  row.style.removeProperty("--swipe-x");
  delete row.dataset.swipe;
  delete row.dataset.swipeArmed;
}

/**
 * Wires the gestures onto the list element. Returns the pull's state and how
 * far it has come, for the indicator above the rows.
 */
export function useListGestures(
  ref: RefObject<HTMLElement | null>,
  options: ListGestureOptions,
): { pull: PullState; pulled: number } {
  const latest = useRef(options);
  latest.current = options;
  const [pull, setPull] = useState<{ state: PullState; px: number }>({ state: "idle", px: 0 });
  const pullRef = useRef(pull);
  pullRef.current = pull;
  const enabled = options.enabled;

  useEffect(() => {
    const root = ref.current;
    if (!enabled || !root) return;
    let start: { x: number; y: number; row: HTMLElement | null; atTop: boolean } | null = null;
    let mode: Mode = "pending";
    let dx = 0;
    let dy = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A long press or a swipe ends with a click the finger did not mean.
    let swallowClick = false;
    const stopTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const scrollTop = () => root.querySelector<HTMLElement>(".vlist")?.scrollTop ?? 0;

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || e.touches.length > 1 || pullRef.current.state === "syncing") {
        start = null;
        stopTimer();
        return;
      }
      const row = rowOf(e.target, root);
      start = { x: t.clientX, y: t.clientY, row, atTop: scrollTop() <= 0 };
      mode = "pending";
      dx = 0;
      dy = 0;
      swallowClick = false;
      stopTimer();
      // A press on a row's own button is that button's, not a selection.
      const onButton = e.target instanceof Element && e.target.closest("button") !== null;
      if (row && !onButton) {
        const id = row.dataset.thread ?? "";
        timer = setTimeout(() => {
          timer = null;
          if (mode !== "pending" || !start) return;
          swallowClick = true;
          start = null;
          latest.current.onLongPress(id);
        }, latest.current.longPressMs);
      }
    };

    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      dx = t.clientX - start.x;
      dy = t.clientY - start.y;
      if (mode === "pending") {
        const next = classifyMove(dx, dy, start.atTop && latest.current.onPull !== undefined);
        if (!next) return;
        stopTimer();
        mode = next === "swipe" && !start.row ? "scroll" : next;
      }
      if (mode === "swipe" && start.row) {
        if (e.cancelable) e.preventDefault();
        const row = start.row;
        row.style.setProperty("--swipe-x", `${dx}px`);
        row.dataset.swipe = dx > 0 ? "right" : "left";
        if (swipeOutcome(dx, latest.current.distance)) row.dataset.swipeArmed = "true";
        else delete row.dataset.swipeArmed;
      } else if (mode === "pull") {
        const px = Math.max(0, dy * PULL_RESISTANCE);
        setPull({ state: px >= latest.current.pullPx ? "ready" : "pulling", px });
      }
    };

    const onEnd = () => {
      stopTimer();
      const from = start;
      start = null;
      if (!from) return;
      if (mode === "swipe" && from.row) {
        const row = from.row;
        const dir = swipeOutcome(dx, latest.current.distance);
        clearRow(row);
        swallowClick = true;
        if (dir) latest.current.onSwipe(row.dataset.thread ?? "", dir);
      } else if (mode === "pull") {
        swallowClick = true;
        const sync = latest.current.onPull;
        if (pullRef.current.state === "ready" && sync) {
          setPull({ state: "syncing", px: latest.current.pullPx });
          void Promise.resolve()
            .then(sync)
            .catch(() => {})
            .finally(() => setPull({ state: "idle", px: 0 }));
        } else setPull({ state: "idle", px: 0 });
      }
      mode = "pending";
    };

    const onCancel = () => {
      stopTimer();
      clearRow(start?.row ?? null);
      start = null;
      mode = "pending";
      if (pullRef.current.state !== "syncing") setPull({ state: "idle", px: 0 });
    };

    const onClick = (e: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    };

    // Android answers a held finger with the context menu; on a row the press is a selection.
    const onMenu = (e: Event) => {
      if (rowOf(e.target, root)) e.preventDefault();
    };

    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("contextmenu", onMenu);
    root.addEventListener("touchmove", onMove, { passive: false });
    root.addEventListener("touchend", onEnd);
    root.addEventListener("touchcancel", onCancel);
    root.addEventListener("click", onClick, true);
    return () => {
      stopTimer();
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("contextmenu", onMenu);
      root.removeEventListener("touchmove", onMove);
      root.removeEventListener("touchend", onEnd);
      root.removeEventListener("touchcancel", onCancel);
      root.removeEventListener("click", onClick, true);
    };
  }, [ref, enabled]);

  return { pull: pull.state, pulled: pull.px };
}
