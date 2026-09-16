// The small pieces: avatar, the monogram mark, buttons, chips, tags, keys,
// inputs, switches, segmented controls, tabs, column heads and section labels.
import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode } from "react";
import { avatarColor, cx, initials } from "../format.ts";
import { Icon, type IconComponent } from "./icon.tsx";

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
  count?: string | number | undefined;
  /** Controls before the title, such as a close button on a sheet. */
  leading?: ReactNode | undefined;
  /** Controls after the spacer, right-aligned. */
  children?: ReactNode | undefined;
  className?: string | undefined;
}

export function ColHead({ title, count, leading, children, className }: ColHeadProps) {
  return (
    <div className={cx("col-head", className)}>
      {leading}
      {title ? <h2>{title}</h2> : null}
      {count !== undefined ? <span className="count">{count}</span> : null}
      <span className="sp" />
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

/* ------------------------------ Vr ------------------------------ */

/** A hairline divider between toolbar groups. */
export function Vr() {
  return <span className="vr" />;
}
