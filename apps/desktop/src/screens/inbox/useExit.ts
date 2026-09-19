// Keeps an overlay on screen for its leave animation: the reader sheet, the
// compose sheet, the palette, a picker, a toast. The caller says whether it
// wants the thing shown; the hook says whether to render it and whether to
// give it the `leaving` class, and takes the element's animationend. The
// durations are the motion tokens in tokens.css (never a number here): when
// the token reads zero, because transitions are off, the system asks for
// less motion, or a test has no stylesheet, the thing leaves at once.

import { useCallback, useEffect, useRef, useState } from "react";

export type MotionToken = "--t-fast" | "--t-med" | "--t-slow";

/** The milliseconds a motion token resolves to on the root right now; 0 when unset. */
export function motionMs(token: MotionToken): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  if (raw === "") return 0;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 0;
  return raw.endsWith("ms") ? n : raw.endsWith("s") ? n * 1000 : n;
}

export interface Exit {
  /** Render the element at all. */
  mounted: boolean;
  /** Give it the class that runs its leave animation. */
  leaving: boolean;
  /** The element's onAnimationEnd; a child's animation ending is not the element's. */
  onEnd: (event?: { target: EventTarget | null; currentTarget: EventTarget | null }) => void;
}

type Phase = "shown" | "leaving" | "gone";

export function useExit(open: boolean, token: MotionToken = "--t-med", onLeft?: () => void): Exit {
  const [phase, setPhase] = useState<Phase>(open ? "shown" : "gone");
  const left = useRef(onLeft);
  left.current = onLeft;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const finish = useCallback(
    (event?: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
      if (event && event.target !== event.currentTarget) return;
      if (phaseRef.current !== "leaving") return;
      phaseRef.current = "gone";
      setPhase("gone");
      left.current?.();
    },
    [],
  );

  useEffect(() => {
    if (open) {
      if (phaseRef.current !== "shown") {
        phaseRef.current = "shown";
        setPhase("shown");
      }
      return;
    }
    if (phaseRef.current !== "shown") return;
    const ms = motionMs(token);
    if (ms <= 0) {
      phaseRef.current = "gone";
      setPhase("gone");
      left.current?.();
      return;
    }
    phaseRef.current = "leaving";
    setPhase("leaving");
    // A safety net under animationend, which a hidden element never fires.
    const timer = setTimeout(() => finish(), ms * 2);
    return () => clearTimeout(timer);
  }, [open, token, finish]);

  return { mounted: phase !== "gone", leaving: phase === "leaving", onEnd: finish };
}

export interface HeldExit<T> extends Exit {
  /** What to render: the current value, or the last one while it leaves; null once gone. */
  value: T | null;
}

/**
 * The same for a value that is the thing shown (the open Thread, the compose
 * Draft, the picker kind): the last value is held while it leaves, so the
 * element can still render it on its way out.
 */
export function useExitValue<T>(
  value: T | null | undefined,
  token: MotionToken = "--t-med",
  onLeft?: () => void,
): HeldExit<T> {
  const held = useRef<T | null>(value ?? null);
  if (value !== null && value !== undefined) held.current = value;
  const exit = useExit(value !== null && value !== undefined, token, onLeft);
  return { ...exit, value: exit.mounted ? held.current : null };
}
