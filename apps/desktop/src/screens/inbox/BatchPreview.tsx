// A batch above the Setting shows its list first with a count and one Apply
// (ADR 0002). Enter applies, Escape cancels.

import type { Thread } from "@monday/shared";
import { Btn, Scrim } from "@monday/ui";
import { useEffect } from "react";

export interface BatchPreviewProps {
  title: string;
  threads: readonly Thread[];
  applyLabel: string;
  cancelLabel: string;
  onApply: () => void;
  onCancel: () => void;
}

export function BatchPreview({
  title,
  threads,
  applyLabel,
  cancelLabel,
  onApply,
  onCancel,
}: BatchPreviewProps) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        onApply();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      } else {
        e.stopPropagation();
      }
    };
    // Capture: the list keymap on the window must not see these keys.
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [onApply, onCancel]);

  return (
    <Scrim onClose={onCancel}>
      <div className="batch" role="dialog" aria-label={title}>
        <div className="batch-h">{title}</div>
        <div className="batch-list">
          {threads.map((t) => (
            <div key={t.id} className="batch-row">
              <span className="from">{t.participants[0]?.name ?? ""}</span>
              <span>{t.subject}</span>
            </div>
          ))}
        </div>
        <div className="batch-foot">
          <Btn onClick={onCancel}>{cancelLabel}</Btn>
          <Btn primary onClick={onApply}>
            {applyLabel}
          </Btn>
        </div>
      </div>
    </Scrim>
  );
}
