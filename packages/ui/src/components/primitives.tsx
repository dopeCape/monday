// The small pieces: avatar, the monogram mark, buttons, chips, tags, keys,
// inputs, switches, segmented controls, tabs, column heads and section labels,
// plus the two hooks a sheet or dialog needs: a focus trap and an Escape.
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
  useEffect,
} from "react";
import { avatarColor, cx, initials } from "../format.ts";
import { Icon, type IconComponent } from "./icon.tsx";

/* ------------------------------ Focus trap and Escape ------------------------------ */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The elements inside `root` that take focus, in document order. */
export function focusableIn(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute("aria-hidden") && el.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Keeps Tab inside a sheet or dialog while it is open: Tab from the last
 * control wraps to the first and Shift+Tab from the first wraps to the last;
 * focus moves into the first control on open and back to where it was on
 * close. Inert while `active` is false, so a component can keep the hook and
 * toggle it.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root || typeof document === "undefined") return;
    const before = document.activeElement as HTMLElement | null;
    if (!root.contains(before)) {
      const first = focusableIn(root)[0] ?? root;
      first.focus?.();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusableIn(root);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !root.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !root.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      if (before && document.contains(before)) before.focus?.();
    };
  }, [ref, active]);
}

/** Calls `onEscape` on Escape anywhere in the document while `active`; the innermost overlay stops the event. */
export function useEscape(onEscape: (() => void) | undefined, active = true): void {
  useEffect(() => {
    if (!active || !onEscape || typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onEscape();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onEscape, active]);
}

/* ------------------------------ Avatar ------------------------------ */

export interface AvatarProps {
  name: string;
  /** Overrides the letters derived from the name, such as a workspace's "GL". */
  initials?: string | undefined;
  /** A CSS color or custom property reference. Defaults to a stable tag color. */
  color?: string | undefined;
  square?: boolean | undefined;
  /** Shows the green sync dot (workspace avatar). */
  live?: boolean | undefined;
  className?: string | undefined;
}

export function Avatar({ name, initials: letters, color, square, live, className }: AvatarProps) {
  const style = { "--c": color ?? avatarColor(name) } as CSSProperties;
  return (
    <span className={cx("avatar", square && "sq", className)} style={style} title={name}>
      {letters ?? initials(name)}
      {live ? <span className="live" /> : null}
    </span>
  );
}

/* ------------------------------ Mark ------------------------------ */

export interface MarkProps {
  small?: boolean | undefined;
  className?: string | undefined;
}

/** The monday monogram. A plain mark, never a sparkle. */
export function Mark({ small, className }: MarkProps) {
  return (
    <span className={cx("mk", small && "sm", className)} aria-hidden="true">
      m
    </span>
  );
}

/* ------------------------------ Btn ------------------------------ */

export interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: boolean | undefined;
  sm?: boolean | undefined;
  primary?: boolean | undefined;
  outline?: boolean | undefined;
  on?: boolean | undefined;
}

export function Btn({ icon, sm, primary, outline, on, className, type, ...rest }: BtnProps) {
  return (
    <button
      type={type ?? "button"}
      className={cx(
        "btn",
        icon && "icon",
        sm && "sm",
        primary && "primary",
        outline && "outline",
        on && "on",
        className,
      )}
      {...rest}
    />
  );
}

/* ------------------------------ Chip ------------------------------ */

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  on?: boolean | undefined;
}

export function Chip({ on, className, type, ...rest }: ChipProps) {
  return <button type={type ?? "button"} className={cx("chip", on && "on", className)} {...rest} />;
}

/* ------------------------------ Tag ------------------------------ */

export type TagKind = "ai" | "warn" | "ok";

export interface TagProps {
  kind?: TagKind | undefined;
  className?: string | undefined;
  children?: ReactNode | undefined;
}

export function Tag({ kind, className, children }: TagProps) {
  return <span className={cx("tag", kind, className)}>{children}</span>;
}

/* ------------------------------ Kbd ------------------------------ */

export interface KbdProps {
  className?: string | undefined;
  children?: ReactNode | undefined;
}

export function Kbd({ className, children }: KbdProps) {
  return <kbd className={cx("kbd", className)}>{children}</kbd>;
}

/* ------------------------------ Input ------------------------------ */

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Input({ className, ...rest }: InputProps) {
  return <input className={cx("input", className)} {...rest} />;
}

/* ------------------------------ Switch ------------------------------ */

export interface SwitchProps {
  on: boolean;
  onChange?: ((on: boolean) => void) | undefined;
  label?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}

export function Switch({ on, onChange, label, disabled, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={cx("switch", on && "on", className)}
      onClick={() => onChange?.(!on)}
    />
  );
}

/* ------------------------------ Seg ------------------------------ */

export interface SegOption<V extends string> {
  value: V;
  label: string;
  icon?: IconComponent | undefined;
}

export interface SegProps<V extends string> {
  options: readonly SegOption<V>[];
  value: V;
  onChange?: ((value: V) => void) | undefined;
  className?: string | undefined;
}

/** A segmented control. One value on at a time. */
export function Seg<V extends string>({ options, value, onChange, className }: SegProps<V>) {
  return (
    <div className={cx("seg", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          className={cx(o.value === value && "on")}
          onClick={() => onChange?.(o.value)}
        >
          {o.icon ? <Icon icon={o.icon} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------ Tabs ------------------------------ */

export interface TabItem<K extends string> {
  key: K;
  label: string;
  count?: number | undefined;
}

export interface TabsProps<K extends string> {
  items: readonly TabItem<K>[];
  active: K;
  onChange?: ((key: K) => void) | undefined;
  className?: string | undefined;
}

export function Tabs<K extends string>({ items, active, onChange, className }: TabsProps<K>) {
  return (
    <div className={cx("tabs", className)} role="tablist">
      {items.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={t.key === active}
          className={cx(t.key === active && "on")}
          onClick={() => onChange?.(t.key)}
        >
          {t.label}
          {t.count !== undefined ? <span className="n">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------ ColHead ------------------------------ */

export interface ColHeadProps {
  title?: string | undefined;
  /** The muted text after the title: a count, a runtime, a month. */
  count?: ReactNode | undefined;
  /** Controls before the title, such as a close button on a sheet. */
  leading?: ReactNode | undefined;
  /** Controls after the spacer, right-aligned. */
  children?: ReactNode | undefined;
  className?: string | undefined;
}

/**
 * The window has no title bar, so every column head is a drag region: the strip,
 * its title, count and spacer move the window; the controls inside still click.
 */
export function ColHead({ title, count, leading, children, className }: ColHeadProps) {
  return (
    <div className={cx("col-head", className)} data-tauri-drag-region>
      {leading}
      {title ? <h2 data-tauri-drag-region>{title}</h2> : null}
      {count !== undefined && count !== null ? (
        <span className="count" data-tauri-drag-region>
          {count}
        </span>
      ) : null}
      <span className="sp" data-tauri-drag-region />
      {children}
    </div>
  );
}

/* ------------------------------ SectionLabel ------------------------------ */

export interface SectionLabelProps {
  children?: ReactNode | undefined;
  className?: string | undefined;
}

/** A Section heading in the stream. */
export function SectionLabel({ children, className }: SectionLabelProps) {
  return <div className={cx("sec", className)}>{children}</div>;
}

/* ------------------------------ Note and EmptyState ------------------------------ */

export type NoteKind = "info" | "ok" | "warn" | "error";

export interface NoteProps {
  kind?: NoteKind | undefined;
  /** An optional Phosphor icon before the text. */
  icon?: IconComponent | undefined;
  className?: string | undefined;
  /** data-* attributes for tests. */
  attrs?: Record<string, string | undefined> | undefined;
  children?: ReactNode | undefined;
}

/**
 * One line of secondary text with a state: a plain note, a success, a
 * warning (a Config file line that did not parse) or an error (a request
 * that failed). Color only for state, no icon unless given.
 */
export function Note({ kind = "info", icon, className, attrs, children }: NoteProps) {
  return (
    <div
      className={cx(
        "note",
        kind === "ok" && "ok",
        kind === "warn" && "warn",
        kind === "error" && "err",
        className,
      )}
      role={kind === "error" || kind === "warn" ? "alert" : undefined}
      {...(attrs ?? {})}
    >
      {icon ? <Icon icon={icon} /> : null}
      <span>{children}</span>
    </div>
  );
}

export interface EmptyStateProps {
  title: ReactNode;
  /** The line under the title: what to do next, never an apology. */
  body?: ReactNode | undefined;
  /** An optional Phosphor icon above the title. */
  icon?: IconComponent | undefined;
  /** One action, such as a Compose or Ask button. */
  action?: ReactNode | undefined;
  /** The page's own empty (left-aligned, under the header) rather than a centered one. */
  page?: boolean | undefined;
  className?: string | undefined;
  attrs?: Record<string, string | undefined> | undefined;
}

/** The shared empty state: a short title, one line of guidance, at most one action. */
export function EmptyState({ title, body, icon, action, page, className, attrs }: EmptyStateProps) {
  return (
    <div className={cx("empty", page && "page-empty", className)} {...(attrs ?? {})}>
      {icon ? (
        <span className="ico">
          <Icon icon={icon} />
        </span>
      ) : null}
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

/* ------------------------------ Vr ------------------------------ */

/** A hairline divider between toolbar groups. */
export function Vr() {
  return <span className="vr" />;
}
