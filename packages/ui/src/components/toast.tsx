// The undo toast: bottom left, a hairline, no icon, the action text and Undo
// with its key. Rises in (app.css), sinks out one fast beat before it expires
// (the `leaving` class), and fades on its own after the Setting's delay. The
// leave beat is read from the --t-fast token on the root, so transitions off
// means it simply expires.
import { useEffect, useRef, useState } from "react";
import { cx } from "../format.ts";
import { Btn, Kbd } from "./primitives.tsx";

export interface ToastProps {
  text: string;
  undoLabel: string;
  /** The key that undoes, as the UI prints it. */
  undoKey: string;
  /** How long the toast stays, from the Setting (inbox.undo_toast_ms). */
  ms: number;
  onUndo?: (() => void) | undefined;
  onExpire: () => void;
  className?: string | undefined;
}

/** The --t-fast token in milliseconds as the document resolved it; 0 without a DOM or with motion off. */
export function leaveBeatMs(): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return 0;
  const value = getComputedStyle(document.documentElement).getPropertyValue("--t-fast").trim();
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return value.endsWith("ms") ? n : n * 1000;
}

export function Toast({ text, undoLabel, undoKey, ms, onUndo, onExpire, className }: ToastProps) {
  const [leaving, setLeaving] = useState(false);
  const expire = useRef(onExpire);
  expire.current = onExpire;
  useEffect(() => {
    const beat = Math.min(leaveBeatMs(), ms);
    const leave = setTimeout(() => setLeaving(true), Math.max(0, ms - beat));
    const gone = setTimeout(() => expire.current(), ms);
    return () => {
      clearTimeout(leave);
      clearTimeout(gone);
    };
  }, [ms]);
  return (
    <div className={cx("toast", leaving && "leaving", className)} role="status">
      <span>{text}</span>
      {onUndo ? (
        <Btn sm onClick={onUndo}>
          {undoLabel} <Kbd>{undoKey}</Kbd>
        </Btn>
      ) : null}
    </div>
  );
}
