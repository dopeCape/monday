// Settings page pieces: a labelled field row and a palette swatch.
import { PlusIcon } from "@phosphor-icons/react";
import type { CSSProperties, ReactNode } from "react";
import { cx } from "../format.ts";
import type { Palette } from "../palettes.ts";
import type { ResolvedMode } from "../theme.tsx";
import { Icon } from "./icon.tsx";

/* ------------------------------ SettingsField ------------------------------ */

export interface SettingsFieldProps {
  label: string;
  hint?: string | undefined;
  /** The control on the right: a Seg, a Switch, a Btn, a Tag. */
  children?: ReactNode | undefined;
  className?: string | undefined;
}

export function SettingsField({ label, hint, children, className }: SettingsFieldProps) {
  return (
    <div className={cx("field", className)}>
      <div className="l">
        <b>{label}</b>
        {hint ? <span>{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

/* ------------------------------ Swatch ------------------------------ */

export interface SwatchProps {
  palette: Palette;
  /** Which half to preview. */
  mode: ResolvedMode;
  on?: boolean | undefined;
  onSelect?: ((key: Palette["key"]) => void) | undefined;
  className?: string | undefined;
}

/** A palette preview card for the Appearance page. */
export function Swatch({ palette, mode, on, onSelect, className }: SwatchProps) {
  const c = palette[mode];
  const style = {
    "--s-bg": c.bg,
    "--s-panel": c.panel,
    "--s-fg": c.fg,
    "--s-accent": c.accent,
    "--s-border": c.border,
  } as CSSProperties;
  return (
    <button
      type="button"
      className={cx("sw", on && "on", className)}
      style={style}
      aria-pressed={on ?? false}
      onClick={() => onSelect?.(palette.key)}
    >
      <div className="pv">
        <div />
        <div>
          <span className="ac" />
          <span className="ln" />
          <span className="ln s" />
        </div>
      </div>
      <div className="lb">
        {palette.label}
        <span>{palette.by}</span>
      </div>
    </button>
  );
}

export interface CustomSwatchProps {
  onSelect?: (() => void) | undefined;
  className?: string | undefined;
}

/** The "Custom, from file" card at the end of the swatches. */
export function CustomSwatch({ onSelect, className }: CustomSwatchProps) {
  const style = {
    "--s-bg": "var(--sunken)",
    "--s-panel": "var(--panel)",
    "--s-fg": "var(--fg-faint)",
    "--s-accent": "var(--fg-faint)",
    "--s-border": "var(--border)",
  } as CSSProperties;
  return (
    <button
      type="button"
      className={cx("sw", "custom", className)}
      style={style}
      onClick={onSelect}
    >
      <div className="pv">
        <div />
        <div>
          <Icon icon={PlusIcon} />
        </div>
      </div>
      <div className="lb">
        Custom
        <span>from file</span>
      </div>
    </button>
  );
}

/* ------------------------------ ChoiceCards ------------------------------ */

export interface ChoiceCard<V extends string> {
  value: V;
  title: string;
  body: string;
  /** A short third line in the foreground color, such as what the choice adds. */
  adds?: string | undefined;
  icon?: ReactNode | undefined;
}

export interface ChoiceCardsProps<V extends string> {
  cards: readonly ChoiceCard<V>[];
  value: V | null;
  onChange?: ((value: V) => void) | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}

/**
 * One choice among a few, as cards: the AI level on onboarding's first screen
 * and at the top of Settings, AI and agent, and the keymap question. The same
 * card primitives as the Sync server upgrade cards; calm, spacious, no glyphs
 * beyond an optional Phosphor icon.
 */
export function ChoiceCards<V extends string>({
  cards,
  value,
  onChange,
  disabled,
  className,
}: ChoiceCardsProps<V>) {
  return (
    <div className={cx("choice-cards", className)} data-count={cards.length}>
      {cards.map((c) => (
        <button
          type="button"
          key={c.value}
          className={cx("choice-card", value === c.value && "on")}
          aria-pressed={value === c.value}
          data-value={c.value}
          disabled={disabled}
          onClick={() => onChange?.(c.value)}
        >
          {c.icon ? <i className="ic">{c.icon}</i> : null}
          <b>{c.title}</b>
          <span>{c.body}</span>
          {c.adds ? <span className="adds">{c.adds}</span> : null}
        </button>
      ))}
    </div>
  );
}
