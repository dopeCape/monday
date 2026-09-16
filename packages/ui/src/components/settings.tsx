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
