// A small keyboard-navigable popover: a heading, a list of choices and an
// optional footer. Arrows or J/K move, Enter picks, Escape closes, a click
// outside closes. Handled keys stop here so the list keymap stays quiet.

import { cx } from "@monday/ui";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";

export interface PickerItem {
  key: string;
  label: string;
  /** Muted text on the right, such as a wake time. */
  detail?: string | undefined;
}

export interface PickerProps {
  title?: string | undefined;
  items: readonly PickerItem[];
  onPick: (key: string) => void;
  onClose: () => void;
  /** Rendered under the items; typing inside it is left alone. */
  children?: ReactNode | undefined;
  className?: string | undefined;
  label: string;
}

export function Picker({ title, items, onPick, onClose, children, className, label }: PickerProps) {
  const [active, setActive] = useState(0);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    host.current?.querySelector<HTMLElement>(".pop-item")?.focus();
    const away = (e: MouseEvent) => {
      if (host.current && !host.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [onClose]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const typing = (e.target as HTMLElement).tagName === "INPUT";
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      onClose();
      return;
    }
    if (typing) {
      e.stopPropagation();
      return;
    }
    const down = e.key === "ArrowDown" || e.key === "j";
    const up = e.key === "ArrowUp" || e.key === "k";
    if (down || up) {
      e.stopPropagation();
      e.preventDefault();
      const n = Math.min(items.length - 1, Math.max(0, active + (down ? 1 : -1)));
      setActive(n);
      host.current?.querySelectorAll<HTMLElement>(".pop-item")[n]?.focus();
      return;
    }
    if (e.key === "Enter") {
      e.stopPropagation();
      e.preventDefault();
      const item = items[active];
      if (item) onPick(item.key);
      return;
    }
    // Any other key belongs to this popover while it is open.
    e.stopPropagation();
  };

  return (
    <div
      ref={host}
      className={cx("pop", className)}
      role="dialog"
      aria-label={label}
      onKeyDown={onKey}
    >
      {title ? <div className="pop-h">{title}</div> : null}
      {items.map((it, i) => (
        <button
          key={it.key}
          type="button"
          className={cx("pop-item", i === active && "on")}
          onMouseEnter={() => setActive(i)}
          onClick={() => onPick(it.key)}
        >
          <span>{it.label}</span>
          {it.detail ? <span className="when">{it.detail}</span> : null}
        </button>
      ))}
      {children}
    </div>
  );
}
