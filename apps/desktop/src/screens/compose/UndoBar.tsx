// The Undo bar after Send: "Sending in 30s" counting down from the send's
// run time, with Undo (ADR 0010). Uses the toast's classes so it sits where
// the undo toasts sit. A send later shows its time instead of a countdown and
// stays as long as an undo toast would; the Scheduled view keeps the Cancel.

import { Btn, formatWhen, Kbd } from "@monday/ui";
import { useEffect, useRef, useState } from "react";

export interface UndoBarStrings {
  /** "Sending in {n}s" */
  sendingIn: string;
  /** Shown once the countdown reaches zero. */
  sendingNow: string;
  /** "Sending {when}" for a later time. */
  scheduledFor: string;
  undo: string;
}

export interface UndoBarProps {
  /** ISO time the Job runs. */
  runAt: string;
  /** The user picked a time from the Later menu: show it, no countdown. */
  later?: boolean | undefined;
  /** How long a later send's bar stays before it clears; the undo toast Setting. */
  stayMs?: number | undefined;
  now?: (() => Date) | undefined;
  strings: UndoBarStrings;
  undoKey?: string | undefined;
  onUndo: () => void;
  /** Called once the countdown passes zero (the send is on its way), or once a later send's bar has stayed. */
  onElapsed?: (() => void) | undefined;
  /** Milliseconds between ticks; tests shorten it. */
  tickMs?: number | undefined;
}

/** Whole seconds left before runAt, never negative. */
export function secondsLeft(runAt: string, at: Date): number {
  return Math.max(0, Math.ceil((Date.parse(runAt) - at.getTime()) / 1000));
}

export function UndoBar({
  runAt,
  later = false,
  stayMs,
  now = () => new Date(),
  strings,
  undoKey,
  onUndo,
  onElapsed,
  tickMs = 250,
}: UndoBarProps) {
  const [left, setLeft] = useState(() => secondsLeft(runAt, now()));
  const elapsed = useRef(onElapsed);
  elapsed.current = onElapsed;

  useEffect(() => {
    if (later) {
      if (stayMs === undefined) return;
      const timer = setTimeout(() => elapsed.current?.(), stayMs);
      return () => clearTimeout(timer);
    }
    let fired = false;
    const tick = () => {
      const n = secondsLeft(runAt, now());
      setLeft(n);
      if (n === 0 && !fired) {
        fired = true;
        elapsed.current?.();
      }
    };
    tick();
    const timer = setInterval(tick, tickMs);
    return () => clearInterval(timer);
  }, [runAt, now, later, stayMs, tickMs]);

  const text = later
    ? strings.scheduledFor.replace("{when}", formatWhen(runAt, now()))
    : left > 0
      ? strings.sendingIn.replace("{n}", String(left))
      : strings.sendingNow;

  return (
    <div className="toast" role="status" data-send-undo>
      <span className="count">{text}</span>
      {later || left > 0 ? (
        <Btn sm onClick={onUndo}>
          {strings.undo} {undoKey ? <Kbd>{undoKey}</Kbd> : null}
        </Btn>
      ) : null}
    </div>
  );
}
