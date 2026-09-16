// The undo toast: bottom left, a hairline, no icon, the action text and Undo
// with its key. Fades on its own after the Setting's delay.

import { Btn, Kbd } from "@monday/ui";
import { useEffect } from "react";

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
  useEffect(() => {
    const t = setTimeout(onExpire, ms);
    return () => clearTimeout(t);
  }, [ms, onExpire]);
  return (
    <div className="toast" role="status">
      <span>{text}</span>
      {onUndo ? (
        <Btn sm onClick={onUndo}>
          {undoLabel} <Kbd>{undoKey}</Kbd>
        </Btn>
      ) : null}
    </div>
  );
}
