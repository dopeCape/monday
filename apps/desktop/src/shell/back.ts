// The phone form's navigation stack: every layer that "back" closes (the
// drawer, the reader over the list, the agent sheet, a Settings page, a
// screen other than the Inbox) registers while it is open, newest on top.
// Back closes the top one, whichever way it came: the Android back button
// (a history step, so each layer also pushes a history entry), the iOS-style
// swipe in from the left edge, or a back button on screen. A layer closed
// from the screen takes its history entry back with it, so the system back
// never lands on a layer that is gone.

import { useEffect, useRef } from "react";

interface Layer {
  id: number;
  back: () => void;
  /** The layer's history entry was already consumed by a popstate. */
  popped: boolean;
}

export interface BackStack {
  /** Registers a layer; the returned function removes it (the layer closed). */
  push(back: () => void): () => void;
  /** Closes the top layer; false when nothing is open. */
  back(): boolean;
  /** How many layers are open. */
  depth(): number;
}

/**
 * A stack over a History. Each layer pushes an entry; a popstate closes the
 * top layer; a layer closed some other way steps history back once and the
 * popstate that follows is swallowed. Without a history (a test) the stack
 * still works through `back()`.
 */
export function createBackStack(target: Window | null): BackStack {
  const layers: Layer[] = [];
  let seq = 0;
  let swallow = 0;
  const history = target?.history ?? null;
  target?.addEventListener("popstate", () => {
    if (swallow > 0) {
      swallow--;
      return;
    }
    const top = layers.pop();
    if (!top) return;
    top.popped = true;
    top.back();
  });
  return {
    push(back) {
      const layer: Layer = { id: ++seq, back, popped: false };
      layers.push(layer);
      try {
        history?.pushState({ mondayBack: layer.id }, "");
      } catch {
        // A sandboxed frame without history: back() still works.
      }
      return () => {
        const at = layers.indexOf(layer);
        if (at >= 0) layers.splice(at, 1);
        if (layer.popped || !history) return;
        layer.popped = true;
        // Only the newest entry can be stepped over without disturbing others.
        if (history.state?.mondayBack === layer.id) {
          swallow++;
          history.back();
        }
      };
    },
    back() {
      const top = layers[layers.length - 1];
      if (!top) return false;
      top.back();
      return true;
    },
    depth: () => layers.length,
  };
}

let shared: BackStack | null = null;
/** The window's one stack. */
export function backStack(): BackStack {
  shared ??= createBackStack(typeof window === "undefined" ? null : window);
  return shared;
}

/** For tests: a fresh stack for the next render. */
export function resetBackStack(stack: BackStack | null = null): void {
  shared = stack;
}

/**
 * Registers a layer on the stack while `open` holds: back calls `close`.
 * The latest `close` is used, so a caller need not memoize it.
 */
export function useBack(open: boolean, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    return backStack().push(() => latest.current());
  }, [open]);
}

/**
 * The swipe in from the left edge: a touch that starts within `edge` pixels
 * of the left and travels at least `distance` to the right, more across than
 * down, goes back one layer.
 */
export function useEdgeSwipeBack(
  enabled: boolean,
  { edge, distance }: { edge: number; distance: number },
): void {
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    let start: { x: number; y: number } | null = null;
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start =
        t && e.touches.length === 1 && t.clientX <= edge ? { x: t.clientX, y: t.clientY } : null;
    };
    const up = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      const from = start;
      start = null;
      if (!from || !t) return;
      const dx = t.clientX - from.x;
      const dy = Math.abs(t.clientY - from.y);
      if (dx >= distance && dx > dy * 1.5) backStack().back();
    };
    const cancel = () => {
      start = null;
    };
    document.addEventListener("touchstart", down, { passive: true });
    document.addEventListener("touchend", up, { passive: true });
    document.addEventListener("touchcancel", cancel, { passive: true });
    return () => {
      document.removeEventListener("touchstart", down);
      document.removeEventListener("touchend", up);
      document.removeEventListener("touchcancel", cancel);
    };
  }, [enabled, edge, distance]);
}
