// monday's own form controls for the Calendar, in place of the browser's
// select, date and time inputs: a dropdown, a date field with a month
// grid, a time field that takes typing and offers the day's times on the
// snap step, and a searchable time zone field. Each opens an anchored
// panel (the .pop.anchored menus the composer uses) in a portal, placed
// below its field or above when there is no room. Arrows move, Enter
// picks, Escape closes the panel without closing what holds it.

import { cx, Icon, MONTH_SHORT, WEEKDAY_SHORT } from "@monday/ui";
import { CaretDownIcon, CaretLeftIcon, CaretRightIcon, CheckIcon } from "@phosphor-icons/react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { type Placement, placeMenu } from "../compose/placement.ts";
import { addDays, addMonths, dayKey, fromDayKey, sameDay, startOfMonth } from "./dates.ts";
import { monthWeeks } from "./layout.ts";

/* ------------------------------ The panel ------------------------------ */

interface FloatingProps {
  anchor: HTMLElement | null;
  onClose: () => void;
  label: string;
  className?: string | undefined;
  children: ReactNode;
  onKeyDown?: ((e: KeyboardEvent<HTMLDivElement>) => void) | undefined;
}

/** A panel anchored to its field, in a portal, closed by a press outside or Escape. */
function Floating({ anchor, onClose, label, className, children, onKeyDown }: FloatingProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
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
        ),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchor]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (host.current?.contains(target) || anchor?.contains(target)) return;
      close.current();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [anchor]);
  return createPortal(
    <div
      ref={host}
      role="dialog"
      aria-label={label}
      className={cx("pop anchored cal-float", place?.above && "above", className)}
      style={{
        top: place?.top ?? 0,
        left: place?.left ?? 0,
        minWidth: anchor ? anchor.getBoundingClientRect().width : undefined,
        visibility: place ? undefined : "hidden",
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          close.current();
          anchor?.focus();
          return;
        }
        onKeyDown?.(e);
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/* ------------------------------ Dropdown ------------------------------ */

export interface DropdownOption<V extends string> {
  value: V;
  label: string;
  /** Muted words on the right. */
  detail?: string | undefined;
  /** A colour dot before the label (a calendar). */
  color?: string | undefined;
  /** A heading the option sits under; options of one group stay together. */
  group?: string | undefined;
}

export interface DropdownProps<V extends string> {
  value: V;
  options: ReadonlyArray<DropdownOption<V>>;
  onChange: (value: V) => void;
  label: string;
  className?: string | undefined;
  /** Shown before the value on the button. */
  leading?: ReactNode;
  disabled?: boolean | undefined;
}

export function Dropdown<V extends string>({
  value,
  options,
  onChange,
  label,
  className,
  leading,
  disabled,
}: DropdownProps<V>) {
  const button = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const i = Math.max(
      0,
      options.findIndex((o) => o.value === value),
    );
    setActive(i);
    requestAnimationFrame(() =>
      list.current?.querySelectorAll<HTMLElement>(".pop-item")[i]?.focus(),
    );
  }, [open, options, value]);
  const pick = (v: V) => {
    setOpen(false);
    onChange(v);
    button.current?.focus();
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const n = Math.min(
        options.length - 1,
        Math.max(0, active + (e.key === "ArrowDown" ? 1 : -1)),
      );
      setActive(n);
      list.current?.querySelectorAll<HTMLElement>(".pop-item")[n]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      const o = options[active];
      if (o) pick(o.value);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      // A letter jumps to the next option starting with it.
      const k = e.key.toLowerCase();
      const n = options.findIndex((o, i) => i > active && o.label.toLowerCase().startsWith(k));
      const m = n >= 0 ? n : options.findIndex((o) => o.label.toLowerCase().startsWith(k));
      if (m >= 0) {
        setActive(m);
        list.current?.querySelectorAll<HTMLElement>(".pop-item")[m]?.focus();
      }
      e.stopPropagation();
    }
  };
  let lastGroup: string | undefined;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={cx("cal-dd", open && "open", className)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {leading}
        {current?.color ? (
          <span className="cal-dot" style={{ "--ev": current.color } as CSSProperties} />
        ) : null}
        <span className="cal-dd-value">{current?.label ?? ""}</span>
        <Icon icon={CaretDownIcon} className="cal-dd-caret" />
      </button>
      {open ? (
        <Floating
          anchor={button.current}
          onClose={() => setOpen(false)}
          label={label}
          onKeyDown={keys}
        >
          <div ref={list} className="cal-dd-list" role="listbox" aria-label={label}>
            {options.map((o, i) => {
              const head = o.group && o.group !== lastGroup ? o.group : null;
              lastGroup = o.group;
              return (
                <div key={o.value}>
                  {head ? <div className="pop-h">{head}</div> : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={o.value === value}
                    className={cx("pop-item", i === active && "on")}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(o.value)}
                  >
                    {o.color ? (
                      <span className="cal-dot" style={{ "--ev": o.color } as CSSProperties} />
                    ) : null}
                    <span className="cal-dd-label">{o.label}</span>
                    {o.detail ? <span className="when">{o.detail}</span> : null}
                    {o.value === value ? <Icon icon={CheckIcon} className="cal-dd-check" /> : null}
                  </button>
                </div>
              );
            })}
          </div>
        </Floating>
      ) : null}
    </>
  );
}

/* ------------------------------ Date ------------------------------ */

export interface DateFieldProps {
  /** "2026-09-24". */
  value: string;
  onChange: (value: string) => void;
  label: string;
  mondayFirst: boolean;
  now: Date;
  previousLabel: string;
  nextLabel: string;
  className?: string | undefined;
}

/** "Thu 24 Sep", with the year when it is not this one. */
export function dateLabel(d: Date, now: Date): string {
  const base = `${WEEKDAY_SHORT[d.getDay()]} ${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

export function DateField({
  value,
  onChange,
  label,
  mondayFirst,
  now,
  previousLabel,
  nextLabel,
  className,
}: DateFieldProps) {
  const button = useRef<HTMLButtonElement | null>(null);
  const grid = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const day = fromDayKey(value) ?? now;
  const [month, setMonth] = useState(() => startOfMonth(day));
  const [focus, setFocus] = useState(day);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on opening, with the day it opens on
  useEffect(() => {
    if (!open) return;
    setMonth(startOfMonth(day));
    setFocus(day);
    requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>(".focus")?.focus());
  }, [open]);
  const move = (d: Date) => {
    setFocus(d);
    if (d.getMonth() !== month.getMonth() || d.getFullYear() !== month.getFullYear())
      setMonth(startOfMonth(d));
    requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>(".focus")?.focus());
  };
  const pick = (d: Date) => {
    setOpen(false);
    onChange(dayKey(d));
    button.current?.focus();
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    if (e.key in step) {
      e.preventDefault();
      e.stopPropagation();
      move(addDays(focus, step[e.key] ?? 0));
    } else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      e.stopPropagation();
      move(addMonths(focus, e.key === "PageUp" ? -1 : 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      pick(focus);
    }
  };
  const weeks = monthWeeks(month, mondayFirst);
  const heads = mondayFirst ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
  return (
    <>
      <button
        ref={button}
        type="button"
        className={cx("cal-field-btn", open && "open", className)}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {dateLabel(day, now)}
      </button>
      {open ? (
        <Floating
          anchor={button.current}
          onClose={() => setOpen(false)}
          label={label}
          onKeyDown={keys}
          className="cal-date-pop"
        >
          <div className="cal-mini-head">
            <b>
              {MONTH_SHORT[month.getMonth()]} {month.getFullYear()}
            </b>
            <button
              type="button"
              className="btn icon sm"
              aria-label={previousLabel}
              onClick={() => setMonth(addMonths(month, -1))}
            >
              <Icon icon={CaretLeftIcon} />
            </button>
            <button
              type="button"
              className="btn icon sm"
              aria-label={nextLabel}
              onClick={() => setMonth(addMonths(month, 1))}
            >
              <Icon icon={CaretRightIcon} />
            </button>
          </div>
          <div className="cal-mini-grid" ref={grid}>
            {heads.map((d) => (
              <span key={d} className="cal-mini-h">
                {WEEKDAY_SHORT[d]?.slice(0, 2)}
              </span>
            ))}
            {weeks.flat().map((d) => (
              <button
                type="button"
                key={d.toISOString()}
                tabIndex={sameDay(d, focus) ? 0 : -1}
                className={cx(
                  "cal-mini-d",
                  sameDay(d, now) && "today",
                  d.getMonth() !== month.getMonth() && "outside",
                  sameDay(d, day) && "picked",
                  sameDay(d, focus) && "focus",
                )}
                aria-label={d.toDateString()}
                aria-pressed={sameDay(d, day)}
                onClick={() => pick(d)}
              >
                {d.getDate()}
              </button>
            ))}
          </div>
        </Floating>
      ) : null}
    </>
  );
}

/* ------------------------------ Time ------------------------------ */

const p2 = (n: number) => String(n).padStart(2, "0");

/**
 * A typed time as "HH:MM": "9", "930", "9:30", "9.30", "9:30pm", "21h30".
 * Null when it is not a time.
 */
export function parseTime(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  const m = /^(\d{1,2})(?:[:.h]?(\d{2}))?(am|pm|a|p)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] ?? "0");
  const half = m[3];
  if (half) {
    if (h < 1 || h > 12) return null;
    if (half.startsWith("p") && h !== 12) h += 12;
    if (half.startsWith("a") && h === 12) h = 0;
  }
  if (h > 23 || mi > 59) return null;
  return `${p2(h)}:${p2(mi)}`;
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** "45 min", "1 h", "1 h 30" between two times on one day. */
export function lengthLabel(
  from: string,
  to: string,
  words: { minutes: string; hours: string },
): string {
  const n = minutesOf(to) - minutesOf(from);
  if (n <= 0) return "";
  if (n < 60) return words.minutes.replace("{n}", String(n));
  const h = Math.floor(n / 60);
  const m = n % 60;
  return words.hours.replace("{h}", String(h)).replace("{m}", m ? ` ${p2(m)}` : "");
}

export interface TimeFieldProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  step: number;
  /** The start, for an end field: the list begins there and shows each length. */
  from?: string | undefined;
  lengthWords?: { minutes: string; hours: string } | undefined;
}

export function TimeField({ value, onChange, label, step, from, lengthWords }: TimeFieldProps) {
  const input = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const times = useMemo(() => {
    const s = Math.max(5, step);
    const out: string[] = [];
    const start = from ? minutesOf(from) + s : 0;
    for (let m = start; m < 24 * 60; m += s) out.push(`${p2(Math.floor(m / 60))}:${p2(m % 60)}`);
    return out;
  }, [step, from]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (!open) return;
    const i = Math.max(
      0,
      times.findIndex((t) => minutesOf(t) >= minutesOf(value)),
    );
    setActive(i);
    requestAnimationFrame(() => {
      const el = list.current?.querySelectorAll<HTMLElement>(".pop-item")[i];
      if (el && list.current) list.current.scrollTop = el.offsetTop - 60;
    });
  }, [open, times, value]);
  const commit = () => {
    const t = parseTime(text);
    if (t) onChange(t);
    else setText(value);
  };
  const pick = (t: string) => {
    setOpen(false);
    setText(t);
    onChange(t);
  };
  return (
    <>
      <input
        ref={input}
        className={cx("cal-field-btn cal-time", open && "open")}
        role="combobox"
        aria-controls={listId}
        aria-label={label}
        aria-expanded={open}
        value={text}
        inputMode="numeric"
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            const n = Math.min(
              times.length - 1,
              Math.max(0, active + (e.key === "ArrowDown" ? 1 : -1)),
            );
            setActive(n);
            const el = list.current?.querySelectorAll<HTMLElement>(".pop-item")[n];
            el?.scrollIntoView?.({ block: "nearest" });
          } else if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            const typed = parseTime(text);
            if (typed && typed !== value) pick(typed);
            else if (open && times[active]) pick(times[active] as string);
            else setOpen(false);
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setText(value);
            setOpen(false);
          } else if (e.key === "Tab") {
            setOpen(false);
          }
        }}
      />
      {open ? (
        <Floating
          anchor={input.current}
          onClose={() => setOpen(false)}
          label={label}
          className="cal-time-pop"
        >
          <div ref={list} id={listId} className="cal-time-list" role="listbox" aria-label={label}>
            {times.map((t, i) => (
              <button
                type="button"
                role="option"
                key={t}
                tabIndex={-1}
                aria-selected={t === value}
                className={cx("pop-item", i === active && "on", t === value && "picked")}
                onMouseEnter={() => setActive(i)}
                // Picked before the input's blur commits the typed text.
                onPointerDown={(e) => {
                  e.preventDefault();
                  pick(t);
                }}
              >
                <span>{t}</span>
                {from && lengthWords ? (
                  <span className="when">{lengthLabel(from, t, lengthWords)}</span>
                ) : null}
              </button>
            ))}
          </div>
        </Floating>
      ) : null}
    </>
  );
}

/* ------------------------------ Time zone ------------------------------ */

export interface ZoneFieldProps {
  value: string;
  onChange: (value: string) => void;
  zones: readonly string[];
  label: string;
  /** The zone's short name, shown after it ("GMT+1"). */
  describe: (zone: string) => string;
  limit: number;
}

export function ZoneField({ value, onChange, zones, label, describe, limit }: ZoneFieldProps) {
  const input = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const [active, setActive] = useState(0);
  useEffect(() => setText(value), [value]);
  const shown = useMemo(() => {
    const q = text.trim().toLowerCase().replace(/\s+/g, "_");
    const all =
      q && q !== value.toLowerCase() ? zones.filter((z) => z.toLowerCase().includes(q)) : zones;
    return all.slice(0, limit);
  }, [text, zones, value, limit]);
  const pick = (z: string) => {
    setOpen(false);
    setText(z);
    onChange(z);
  };
  return (
    <>
      <input
        ref={input}
        className={cx("cal-field-btn cal-zone", open && "open")}
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-controls="cal-zone-list"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          if (zones.includes(text)) onChange(text);
          else setText(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            setActive((a) =>
              Math.min(shown.length - 1, Math.max(0, a + (e.key === "ArrowDown" ? 1 : -1))),
            );
          } else if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            const z = shown[active];
            if (open && z) pick(z);
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setText(value);
            setOpen(false);
          }
        }}
      />
      {open && shown.length > 0 ? (
        <Floating
          anchor={input.current}
          onClose={() => setOpen(false)}
          label={label}
          className="cal-zone-pop"
        >
          <div id="cal-zone-list" className="cal-time-list" role="listbox" aria-label={label}>
            {shown.map((z, i) => (
              <button
                type="button"
                role="option"
                key={z}
                tabIndex={-1}
                aria-selected={z === value}
                className={cx("pop-item", i === active && "on")}
                onMouseEnter={() => setActive(i)}
                onPointerDown={(e) => {
                  e.preventDefault();
                  pick(z);
                }}
              >
                <span>{z.replaceAll("_", " ")}</span>
                <span className="when">{describe(z)}</span>
              </button>
            ))}
          </div>
        </Floating>
      ) : null}
    </>
  );
}
