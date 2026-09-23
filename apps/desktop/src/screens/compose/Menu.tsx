// A menu anchored to the button that opened it: the Later menu, the assist
// menu, the link field, the dock's "+N" list. It renders in a portal on the
// document body with a fixed position read from the button, so no scrim,
// sheet or clipped container decides where it lands or what covers it; the
// stylesheet puts it above every scrim. Below the button when there is room,
// above it when there is not. Arrows or J/K move, Enter picks, Escape and a
// click outside close, and the focus goes back to the button.

import { cx } from "@monday/ui";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  key: string;
  label: string;
  /** Muted text on the right, such as a send time. */
  detail?: string | undefined;
}

export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface Placement {
  top: number;
  left: number;
  /** Opened above the button (no room below). */
  above: boolean;
}

/** Room kept between the menu and the window edge. */
const EDGE = 8;

/**
 * Where a menu of `size` goes for a button at `anchor` in a `viewport`: below
 * with `gap` when it fits, above when only that fits, else on the roomier
 * side. Aligned to the button's start (or end), kept inside the window.
 */
export function placeMenu(
  anchor: Rect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  options: { gap?: number; align?: "start" | "end" } = {},
): Placement {
  const gap = options.gap ?? 6;
  const below = viewport.height - anchor.bottom - gap - EDGE;
  const aboveRoom = anchor.top - gap - EDGE;
  const above = size.height > below && (size.height <= aboveRoom || aboveRoom > below);
  const top = above
    ? Math.max(EDGE, anchor.top - gap - size.height)
    : Math.min(anchor.bottom + gap, Math.max(EDGE, viewport.height - EDGE - size.height));
  const wanted = options.align === "end" ? anchor.right - size.width : anchor.left;
  const left = Math.min(Math.max(EDGE, wanted), Math.max(EDGE, viewport.width - EDGE - size.width));
  return { top, left, above };
}

export interface AnchoredMenuProps {
  /** The button the menu belongs to; the menu follows it and gives the focus back to it. */
  anchor: HTMLElement | null;
  label: string;
  title?: string | undefined;
  items: readonly MenuItem[];
  onPick: (key: string) => void;
  onClose: () => void;
  /** Rendered under the items (an input): typing in it is left alone. */
  children?: ReactNode | undefined;
  className?: string | undefined;
  align?: "start" | "end" | undefined;
  /** Focus the first item on open (default), or leave the focus to the children. */
  focusItems?: boolean | undefined;
}

export function AnchoredMenu({
  anchor,
  label,
  title,
  items,
  onPick,
  onClose,
  children,
  className,
  align = "start",
  focusItems = true,
}: AnchoredMenuProps) {
  const host = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<Placement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const close = useCallback(() => {
    closeRef.current();
    anchor?.focus();
  }, [anchor]);

  // Measured before paint, so the menu never flashes at the wrong spot.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el || !anchor) return;
    const measure = () => {
      const r = anchor.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      setPlace(
        placeMenu(
          { top: r.top, left: r.left, bottom: r.bottom, right: r.right },
          { width: box.width, height: box.height },
          { width: window.innerWidth, height: window.innerHeight },
          { align },
        ),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchor, align]);

  useEffect(() => {
    if (focusItems) host.current?.querySelector<HTMLElement>(".pop-item")?.focus();
    const away = (e: MouseEvent) => {
      const target = e.target as Node;
      if (host.current?.contains(target)) return;
      // The button toggles the menu itself.
      if (anchor?.contains(target)) return;
      closeRef.current();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [anchor, focusItems]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const typing = (e.target as HTMLElement).tagName === "INPUT";
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      close();
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
    e.stopPropagation();
  };

  return createPortal(
    <div
      ref={host}
      className={cx("pop anchored", place?.above && "above", className)}
      role="menu"
      aria-label={label}
      data-placement={place ? (place.above ? "above" : "below") : undefined}
      style={{
        top: place?.top ?? 0,
        left: place?.left ?? 0,
        visibility: place ? undefined : "hidden",
      }}
      onKeyDown={onKey}
    >
      {title ? <div className="pop-h">{title}</div> : null}
      {items.map((it, i) => (
        <button
          key={it.key}
          type="button"
          role="menuitem"
          className={cx("pop-item", i === active && "on")}
          onMouseEnter={() => setActive(i)}
          onClick={() => onPick(it.key)}
        >
          <span>{it.label}</span>
          {it.detail ? <span className="when">{it.detail}</span> : null}
        </button>
      ))}
      {children}
    </div>,
    document.body,
  );
}
