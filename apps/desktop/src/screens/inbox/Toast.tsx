// The undo toast: bottom left, a hairline, no icon, the action text and Undo
// with its key. Fades on its own after the Setting's delay, counted from
// when it appeared: a re-render of the screen (a new onExpire closure) does
// not restart it. The leave runs through the exit hook, so it slides away
// on the motion tokens and vanishes at once when transitions are off.

import { Btn, Kbd } from "@monday/ui";
import { useEffect, useRef, useState } from "react";
import { useExit } from "./useExit.ts";

export interface ToastProps {
  text: string;
  undoLabel: string;
  /** The key that undoes, as the UI prints it. */
  undoKey: string;
  ms: number;
  onUndo?: (() => void) | undefined;
  onExpire: () => void;
}

export function Toast({ text, undoLabel, undoKey, ms, onUndo, onExpire }: ToastProps) {
  const [shown, setShown] = useState(true);
  const expire = useRef(onExpire);
  expire.current = onExpire;
  useEffect(() => {
    const t = setTimeout(() => setShown(false), ms);
    return () => clearTimeout(t);
  }, [ms]);
  const exit = useExit(shown, "--t-fast", () => expire.current());
  if (!exit.mounted) return null;
  return (
    <div
      className={exit.leaving ? "toast leaving" : "toast"}
      role="status"
      onAnimationEnd={exit.onEnd}
    >
      <span>{text}</span>
      {onUndo ? (
        <Btn sm onClick={onUndo}>
          {undoLabel} <Kbd>{undoKey}</Kbd>
        </Btn>
      ) : null}
    </div>
  );
}
