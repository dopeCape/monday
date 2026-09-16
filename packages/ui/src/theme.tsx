// Theme, palette, density and layout knobs applied to the document root.
// The Shell owns the values and their persistence; this only mirrors them onto
// data attributes so the CSS in tokens.css and app.css can react to them.

import type { Density, Layout, ThemeMode } from "@monday/shared";
import { PRESETS } from "@monday/shared";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import type { PaletteKey } from "./palettes.ts";

export type ResolvedMode = "light" | "dark";
export type PresetName = keyof typeof PRESETS | "custom";

export interface ThemeProps {
  mode: ThemeMode;
  palette: PaletteKey;
  density: Density;
  layout: Layout;
}

export interface ThemeValue extends ThemeProps {
  /** "system" resolved against prefers-color-scheme. */
  resolved: ResolvedMode;
  /** The preset name the layout knobs add up to, or "custom". */
  preset: PresetName;
  /** The attributes as they are written to the document root. */
  attributes: ThemeAttributes;
}

export interface ThemeAttributes {
  "data-theme": ResolvedMode;
  "data-palette": PaletteKey;
  "data-density": Density;
  "data-layout": PresetName;
  "data-nav": Layout["nav"];
  "data-agent": Layout["agent"];
  "data-list": Layout["list"];
}

/** The part of an Element the provider writes to. Lets tests pass a fake root. */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
}

export function presetName(layout: Layout): PresetName {
  for (const [name, preset] of Object.entries(PRESETS)) {
    if (preset.nav === layout.nav && preset.agent === layout.agent && preset.list === layout.list) {
      return name as keyof typeof PRESETS;
    }
  }
  return "custom";
}

export function resolveMode(mode: ThemeMode, prefersDark: boolean): ResolvedMode {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}

export function themeAttributes(props: ThemeProps, prefersDark: boolean): ThemeAttributes {
  return {
    "data-theme": resolveMode(props.mode, prefersDark),
    "data-palette": props.palette,
    "data-density": props.density,
    "data-layout": presetName(props.layout),
    "data-nav": props.layout.nav,
    "data-agent": props.layout.agent,
    "data-list": props.layout.list,
  };
}

export function applyThemeAttributes(root: ThemeRoot, attributes: ThemeAttributes): void {
  for (const [name, value] of Object.entries(attributes)) root.setAttribute(name, value);
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(DARK_QUERY).matches;
}

/** Tracks prefers-color-scheme. Only subscribes when the mode is "system". */
function usePrefersDark(active: boolean): boolean {
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  useEffect(() => {
    if (!active) return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(DARK_QUERY);
    const sync = () => setPrefersDark(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [active]);
  return prefersDark;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export interface ThemeProviderProps extends ThemeProps {
  /** Where the attributes go. Defaults to document.documentElement. */
  root?: ThemeRoot | undefined;
  children?: ReactNode | undefined;
}

export function ThemeProvider({
  mode,
  palette,
  density,
  layout,
  root,
  children,
}: ThemeProviderProps) {
  const prefersDark = usePrefersDark(mode === "system");
  const value = useMemo<ThemeValue>(() => {
    const props = { mode, palette, density, layout };
    const attributes = themeAttributes(props, prefersDark);
    return {
      ...props,
      resolved: attributes["data-theme"],
      preset: attributes["data-layout"],
      attributes,
    };
  }, [mode, palette, density, layout, prefersDark]);

  useEffect(() => {
    const target = root ?? (typeof document === "undefined" ? null : document.documentElement);
    if (target) applyThemeAttributes(target, value.attributes);
  }, [root, value]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme needs a ThemeProvider above it");
  return value;
}
