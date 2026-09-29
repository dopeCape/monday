// monday's dropdown, in place of the browser's <select>: a button showing the
// current choice that opens a listbox in a portal on the document body, placed
// below the button or above it when there is no room (the .pop.anchored menus
// the composer uses). Arrows, Home and End move, Enter or Space picks, typing
// jumps to the option that starts with what was typed, Escape and Tab close,
// and the focus goes back to the button. On the closed button the arrows open
// the list, and typing picks the matching option as a native select does.

import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "../format.ts";
import { type Placement, placeMenu } from "../placement.ts";
import { Icon } from "./icon.tsx";

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  /** Muted words on the right. */
  detail?: string | undefined;
  /** A colour dot before the label (a calendar). */
  color?: string | undefined;
  /** A heading the option sits under; options of one group stay together. */
  group?: string | undefined;
}

export interface SelectProps<V extends string> {
  value: V;
  options: ReadonlyArray<SelectOption<V>>;
  onChange: (value: V) => void;
  /** The accessible name of the button and the list. */
  label?: string | undefined;
  /** For a <label htmlFor> elsewhere on the page. */
  id?: string | undefined;
  className?: string | undefined;
  /** Extra classes on the floating list. */
  panelClassName?: string | undefined;
  /** Shown before the value on the button. */
  leading?: ReactNode;
  disabled?: boolean | undefined;
}

/** How long typed letters keep adding to one search. */
const TYPEAHEAD_MS = 700;

/**
 * The option a typed `query` lands on, searching after `from` and wrapping.
 * One letter typed again moves to the next option with that letter.
 */
export function typeaheadIndex(
  labels: readonly string[],
  query: string,
  from: number,
): number | null {
  const q = query.toLowerCase();
  if (!q) return null;
  const n = labels.length;
  // A fresh search, or one letter repeated, starts after the current option.
  const repeat = q.length > 1 && [...q].every((c) => c === q[0]);
  const needle = repeat ? (q[0] ?? "") : q;
  const start = q.length === 1 || repeat ? from + 1 : from;
  for (let i = 0; i < n; i++) {
    const at = (((start + i) % n) + n) % n;
    if ((labels[at] ?? "").toLowerCase().startsWith(needle)) return at;
  }
  return null;
}

function useTypeahead() {
  const buffer = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (key: string) => {
    buffer.current += key;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      buffer.current = "";
    }, TYPEAHEAD_MS);
    return buffer.current;
  };
}

/** Focuses the option at `i` in an open list. */
function focusOption(list: HTMLElement | null, i: number): void {
  list?.querySelectorAll<HTMLElement>("[role='option']")[i]?.focus();
}

const printable = (e: KeyboardEvent) =>
  e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey;

export function Select<V extends string>({
  value,
  options,
  onChange,
  label,
  id,
  className,
  panelClassName,
  leading,
  disabled,
}: SelectProps<V>) {
  const button = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<Placement | null>(null);
  const listId = useId();
  const type = useTypeahead();
  const selected = options.findIndex((o) => o.value === value);
  const current = options[selected];
  const labels = options.map((o) => o.label);

  const close = (refocus = true) => {
    setOpen(false);
    setPlace(null);
    if (refocus) button.current?.focus();
  };

  const pick = (v: V) => {
    close();
    if (v !== value) onChange(v);
  };

  // On open, the current option is active and focused.
  useEffect(() => {
    if (!open) return;
    const i = Math.max(0, selected);
    setActive(i);
    focusOption(list.current, i);
  }, [open, selected]);

  // Measured before paint, so the list never flashes at the wrong spot.
  useLayoutEffect(() => {
    if (!open) return;
    const el = host.current;
    const anchor = button.current;
    if (!el || !anchor) return;
    const measure = () => {
      const r = anchor.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      setPlace(
        placeMenu(
          { top: r.top, left: r.left, bottom: r.bottom, right: r.right },
          { width: box.width, height: box.height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  // A press outside closes the list; the button toggles it itself.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (host.current?.contains(target) || button.current?.contains(target)) return;
      setOpen(false);
      setPlace(null);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);

  const move = (n: number) => {
    const i = Math.min(options.length - 1, Math.max(0, n));
    setActive(i);
    focusOption(list.current, i);
  };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Nothing here reaches the sheet or screen that holds the Select.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      // Back on the button, so the Tab itself moves on from there.
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(active + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      move(e.key === "Home" ? 0 : options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const o = options[active];
      if (o) pick(o.value);
    } else if (printable(e)) {
      const i = typeaheadIndex(labels, type(e.key), active);
      if (i !== null) move(i);
    }
  };

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(true);
    } else if (printable(e)) {
      // Typing on the closed button picks as a native select does.
      e.stopPropagation();
      const i = typeaheadIndex(labels, type(e.key), selected);
      const o = i === null ? undefined : options[i];
      if (o && o.value !== value) onChange(o.value);
    }
  };

  let lastGroup: string | undefined;
  return (
    <>
      <button
        ref={button}
        id={id}
        type="button"
        className={cx("dd", open && "open", className)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={onButtonKey}
      >
        {leading}
        {current?.color ? (
          <span className="cal-dot" style={{ "--ev": current.color } as CSSProperties} />
        ) : null}
        <span className="dd-value">{current?.label ?? ""}</span>
        <Icon icon={CaretDownIcon} className="dd-caret" />
      </button>
      {open
        ? createPortal(
            <div
              ref={host}
              className={cx("pop anchored dd-float", place?.above && "above", panelClassName)}
              data-placement={place ? (place.above ? "above" : "below") : undefined}
              style={{
                top: place?.top ?? 0,
                left: place?.left ?? 0,
                minWidth: button.current?.getBoundingClientRect().width || undefined,
                visibility: place ? undefined : "hidden",
              }}
            >
              <div
                ref={list}
                id={listId}
                className="dd-list"
                role="listbox"
                aria-label={label}
                onKeyDown={onListKey}
              >
                {options.map((o, i) => {
                  const head = o.group && o.group !== lastGroup ? o.group : null;
                  lastGroup = o.group;
                  return (
                    <div key={o.value} role="presentation">
                      {head ? (
                        <div className="pop-h" role="presentation">
                          {head}
                        </div>
                      ) : null}
                      <button
                        type="button"
                        role="option"
                        aria-selected={o.value === value}
                        tabIndex={i === active ? 0 : -1}
                        className={cx("pop-item", i === active && "on")}
                        data-value={o.value}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => pick(o.value)}
                      >
                        {o.color ? (
                          <span className="cal-dot" style={{ "--ev": o.color } as CSSProperties} />
                        ) : null}
                        <span className="dd-label">{o.label}</span>
                        {o.detail ? <span className="when">{o.detail}</span> : null}
                        {o.value === value ? <Icon icon={CheckIcon} className="dd-check" /> : null}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
