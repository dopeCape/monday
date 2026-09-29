// The window's title strip, drawn by monday since the native decorations are
// off: a quiet band across the top that moves the window when dragged and
// maximizes it on a double press, with minimize, maximize (restore while
// maximized) and close at the right. The buttons stay faint until hovered;
// close turns the danger colour, as native title bars do.

import { CopySimpleIcon, MinusIcon, SquareIcon, XIcon } from "@phosphor-icons/react";
import type { MouseEvent } from "react";
import { Icon } from "./icon.tsx";

export interface TitleBarLabels {
  minimize: string;
  maximize: string;
  restore: string;
  close: string;
}

export interface TitleBarProps {
  maximized: boolean;
  labels: TitleBarLabels;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
  /** A primary press on the strip itself (not a button): the window follows the pointer. */
  onDrag: () => void;
}

export function TitleBar({
  maximized,
  labels,
  onMinimize,
  onToggleMaximize,
  onClose,
  onDrag,
}: TitleBarProps) {
  const press = (e: MouseEvent<HTMLDivElement>) => {
    // Only the strip's own surface drags; the buttons keep their clicks.
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    if (e.detail === 2) onToggleMaximize();
    else onDrag();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the drag surface is pointer-only; the buttons carry the keyboard.
    <div className="titlebar" onMouseDown={press}>
      <div className="win-ctl">
        <button
          type="button"
          className="win-btn"
          aria-label={labels.minimize}
          title={labels.minimize}
          onClick={onMinimize}
        >
          <Icon icon={MinusIcon} />
        </button>
        <button
          type="button"
          className="win-btn"
          aria-label={maximized ? labels.restore : labels.maximize}
          title={maximized ? labels.restore : labels.maximize}
          data-state={maximized ? "maximized" : "normal"}
          onClick={onToggleMaximize}
        >
          <Icon icon={maximized ? CopySimpleIcon : SquareIcon} />
        </button>
        <button
          type="button"
          className="win-btn close"
          aria-label={labels.close}
          title={labels.close}
          onClick={onClose}
        >
          <Icon icon={XIcon} />
        </button>
      </div>
    </div>
  );
}
