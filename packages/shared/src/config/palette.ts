// Palette files. A Palette is a named set of color tokens with a light and a
// dark half (CONTEXT.md). Two file shapes are accepted:
//
//   1. Token TOML: `name = "..."` plus `[light]` and `[dark]` tables whose keys
//      are the token names from packages/ui tokens.css without the `--`.
//   2. A base16 YAML scheme (base00..base0F), mapped to tokens by BASE16_MAPPING
//      below. One scheme is one half; the other half mirrors it unless a second
//      scheme is given.
//
// The base colors are required. The translucent and shadow tokens are derived
// from them when absent, so a hand-written palette needs nineteen colors.

import { parse as parseToml, TomlError } from "smol-toml";

export const REQUIRED_TOKENS = [
  "bg",
  "panel",
  "sunken",
  "raised",
  "overlay",
  "fg",
  "fg-muted",
  "fg-faint",
  "accent",
  "accent-fg",
  "success",
  "warning",
  "danger",
  "info",
  "tag-1",
  "tag-2",
  "tag-3",
  "tag-4",
  "tag-5",
] as const;

export const DERIVED_TOKENS = [
  "hover",
  "active",
  "border",
  "border-strong",
  "accent-soft",
  "accent-ring",
  "selection",
  "shadow-sm",
  "shadow-md",
  "shadow-lg",
] as const;

export const PALETTE_TOKENS = [...REQUIRED_TOKENS, ...DERIVED_TOKENS] as const;

export type RequiredToken = (typeof REQUIRED_TOKENS)[number];
export type DerivedToken = (typeof DERIVED_TOKENS)[number];
export type TokenName = (typeof PALETTE_TOKENS)[number];
export type Tokens = Record<TokenName, string>;
export type Half = "light" | "dark";

export interface Palette {
  name: string;
  light: Tokens;
  dark: Tokens;
}

export interface PaletteProblem {
  half: Half | null;
  token: string | null;
  message: string;
}

export type PaletteResult =
  | { ok: true; palette: Palette }
  | { ok: false; problems: PaletteProblem[] };

/* ------------------------------ Colors ------------------------------ */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function parseHex(value: string): Rgb | null {
  const match = HEX.exec(value.trim());
  if (!match) return null;
  let hex = match[1] as string;
  if (hex.length <= 4) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function toHex(rgb: Rgb): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}`;
}

function rgba(rgb: Rgb, alpha: number): string {
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/** Relative luminance, 0 (black) to 1 (white). */
export function luminance(rgb: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * A CSS color that is not plain hex (rgba(), hsl(), a named color) is accepted
 * as-is for any token; derivation needs hex for the tokens it reads.
 */
function looksLikeColor(value: string): boolean {
  const v = value.trim();
  return HEX.test(v) || /^(rgba?|hsla?|oklch|color)\(/.test(v) || /^[a-z]+$/i.test(v);
}

/* ------------------------------ Derivation ------------------------------ */

const ALPHA: Record<Half, Record<DerivedToken, number>> = {
  light: {
    hover: 0.045,
    active: 0.08,
    border: 0.08,
    "border-strong": 0.16,
    "accent-soft": 0.1,
    "accent-ring": 0.35,
    selection: 0.22,
    "shadow-sm": 0,
    "shadow-md": 0,
    "shadow-lg": 0,
  },
  dark: {
    hover: 0.05,
    active: 0.09,
    border: 0.08,
    "border-strong": 0.16,
    "accent-soft": 0.14,
    "accent-ring": 0.4,
    selection: 0.3,
    "shadow-sm": 0,
    "shadow-md": 0,
    "shadow-lg": 0,
  },
};

/** Fill in every derived token that is absent, from fg and accent. */
export function completeTokens(
  given: Partial<Record<TokenName, string>>,
  half: Half,
): Record<TokenName, string> {
  const out = { ...given } as Record<TokenName, string>;
  const fg =
    parseHex(given.fg ?? "") ??
    (half === "dark" ? { r: 236, g: 236, b: 239 } : { r: 24, g: 24, b: 27 });
  const accent = parseHex(given.accent ?? "") ?? { r: 61, g: 99, b: 221 };
  const shadowBase = half === "dark" ? { r: 0, g: 0, b: 0 } : fg;
  const ring = half === "dark" ? rgba(fg, 0.06) : rgba(fg, 0.05);
  const a = ALPHA[half];
  const derived: Record<DerivedToken, string> = {
    hover: rgba(fg, a.hover),
    active: rgba(fg, a.active),
    border: rgba(fg, a.border),
    "border-strong": rgba(fg, a["border-strong"]),
    "accent-soft": rgba(accent, a["accent-soft"]),
    "accent-ring": rgba(accent, a["accent-ring"]),
    selection: rgba(accent, a.selection),
    "shadow-sm": `0 1px 2px ${rgba(shadowBase, half === "dark" ? 0.4 : 0.06)}, 0 0 0 1px ${ring}`,
    "shadow-md": `0 8px 24px -8px ${rgba(shadowBase, half === "dark" ? 0.6 : 0.18)}, 0 0 0 1px ${ring}`,
    "shadow-lg": `0 24px 64px -16px ${rgba(shadowBase, half === "dark" ? 0.8 : 0.28)}, 0 0 0 1px ${ring}`,
  };
  for (const token of DERIVED_TOKENS) {
    if (out[token] === undefined || out[token] === "") out[token] = derived[token];
  }
  return out;
}

/** Check one half: every required token present and every value a color. Derives the rest. */
export function validateHalf(
  half: Half,
  raw: unknown,
): { ok: true; tokens: Tokens } | { ok: false; problems: PaletteProblem[] } {
  const problems: PaletteProblem[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      problems: [{ half, token: null, message: `[${half}] must be a table of tokens` }],
    };
  }
  const table = raw as Record<string, unknown>;
  const given: Partial<Record<TokenName, string>> = {};
  for (const [key, value] of Object.entries(table)) {
    if (!(PALETTE_TOKENS as readonly string[]).includes(key)) {
      problems.push({ half, token: key, message: `Unknown token "${key}"` });
      continue;
    }
    if (typeof value !== "string" || !looksLikeColor(value)) {
      problems.push({ half, token: key, message: `${key} must be a color string` });
      continue;
    }
    given[key as TokenName] = value.trim();
  }
  for (const token of REQUIRED_TOKENS) {
    if (given[token] === undefined)
      problems.push({ half, token, message: `Missing token "${token}"` });
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, tokens: completeTokens(given, half) };
}

/* ------------------------------ Token TOML ------------------------------ */

export function parsePaletteToml(text: string, fallbackName = "custom"): PaletteResult {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch (err) {
    const message =
      err instanceof TomlError ? `Line ${err.line}: ${err.message.split("\n")[0]}` : String(err);
    return { ok: false, problems: [{ half: null, token: null, message }] };
  }
  const problems: PaletteProblem[] = [];
  const halves: Partial<Record<Half, Tokens>> = {};
  for (const half of ["light", "dark"] as const) {
    if (!(half in doc)) {
      problems.push({ half, token: null, message: `Missing [${half}] table` });
      continue;
    }
    const result = validateHalf(half, doc[half]);
    if (result.ok) halves[half] = result.tokens;
    else problems.push(...result.problems);
  }
  for (const key of Object.keys(doc)) {
    if (key !== "light" && key !== "dark" && key !== "name") {
      problems.push({ half: null, token: key, message: `Unknown key "${key}"` });
    }
  }
  if (problems.length > 0 || !halves.light || !halves.dark) return { ok: false, problems };
  const name =
    typeof doc.name === "string" && doc.name.trim() !== "" ? doc.name.trim() : fallbackName;
  return { ok: true, palette: { name, light: halves.light, dark: halves.dark } };
}

/* ------------------------------ base16 ------------------------------ */

export type Base16Slot =
  | "base00"
  | "base01"
  | "base02"
  | "base03"
  | "base04"
  | "base05"
  | "base06"
  | "base07"
  | "base08"
  | "base09"
  | "base0A"
  | "base0B"
  | "base0C"
  | "base0D"
  | "base0E"
  | "base0F";

export const BASE16_SLOTS: readonly Base16Slot[] = [
  "base00",
  "base01",
  "base02",
  "base03",
  "base04",
  "base05",
  "base06",
  "base07",
  "base08",
  "base09",
  "base0A",
  "base0B",
  "base0C",
  "base0D",
  "base0E",
  "base0F",
];

export interface Base16Scheme {
  name: string;
  colors: Record<Base16Slot, string>;
  /** Which half the scheme is, decided by base00's luminance. */
  half: Half;
}

/**
 * How base16 slots become monday tokens. base16 orders base00..base03 from the
 * default background outward: away from black in a dark scheme, away from
 * white in a light one. monday's panel is lighter than bg in both modes, so
 * the surface slots differ per half while the text and accent slots do not.
 *
 *   dark:  bg base00, sunken base00, panel base01, raised base02, overlay base02
 *   light: bg base01, sunken base02, panel base00, raised base00, overlay base00
 *   both:  fg base05, fg-muted base04, fg-faint base03,
 *          accent base0D, success base0B, warning base0A, danger base08, info base0C,
 *          tag-1 base0D, tag-2 base0B, tag-3 base09, tag-4 base0E, tag-5 base0C
 *   accent-fg: base00 or base07, whichever contrasts more with the accent.
 *   The derived tokens (hover, border, selection, shadows) come from completeTokens.
 */
export const BASE16_MAPPING: Record<
  Half,
  Record<Exclude<RequiredToken, "accent-fg">, Base16Slot>
> = {
  dark: {
    bg: "base00",
    sunken: "base00",
    panel: "base01",
    raised: "base02",
    overlay: "base02",
    fg: "base05",
    "fg-muted": "base04",
    "fg-faint": "base03",
    accent: "base0D",
    success: "base0B",
    warning: "base0A",
    danger: "base08",
    info: "base0C",
    "tag-1": "base0D",
    "tag-2": "base0B",
    "tag-3": "base09",
    "tag-4": "base0E",
    "tag-5": "base0C",
  },
  light: {
    bg: "base01",
    sunken: "base02",
    panel: "base00",
    raised: "base00",
    overlay: "base00",
    fg: "base05",
    "fg-muted": "base04",
    "fg-faint": "base03",
    accent: "base0D",
    success: "base0B",
    warning: "base0A",
    danger: "base08",
    info: "base0C",
    "tag-1": "base0D",
    "tag-2": "base0B",
    "tag-3": "base09",
    "tag-4": "base0E",
    "tag-5": "base0C",
  },
};

/** Cut a YAML line at the first `#` outside quotes; a `#` inside quotes is a color. */
function stripYamlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Read a base16 scheme YAML. Both the classic flat file (`base00: "181818"`)
 * and the tinted-theming file with a `palette:` map are accepted; indentation
 * and quoting are ignored, which is all these files need.
 */
export function parseBase16(
  text: string,
): { ok: true; scheme: Base16Scheme } | { ok: false; problems: PaletteProblem[] } {
  const colors: Partial<Record<Base16Slot, string>> = {};
  let name = "";
  for (const rawLine of text.split("\n")) {
    const line = stripYamlComment(rawLine);
    const match = /^\s*-?\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] as string;
    const value = (match[2] as string)
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();
    const slot = /^base0[0-9A-Fa-f]$/.test(key)
      ? (`base0${key.slice(5).toUpperCase()}` as Base16Slot)
      : null;
    if (slot) {
      colors[slot] = value;
      continue;
    }
    if ((key === "scheme" || key === "name") && value !== "" && name === "") name = value;
  }
  const problems: PaletteProblem[] = [];
  for (const slot of BASE16_SLOTS) {
    const value = colors[slot];
    if (value === undefined) problems.push({ half: null, token: slot, message: `Missing ${slot}` });
    else if (!parseHex(value))
      problems.push({ half: null, token: slot, message: `${slot} is not a hex color` });
  }
  if (problems.length > 0) return { ok: false, problems };
  const normalized = Object.fromEntries(
    BASE16_SLOTS.map((slot) => [slot, toHex(parseHex(colors[slot] as string) as Rgb)]),
  ) as Record<Base16Slot, string>;
  const half: Half = luminance(parseHex(normalized.base00) as Rgb) < 0.5 ? "dark" : "light";
  return { ok: true, scheme: { name, colors: normalized, half } };
}

/** Map one scheme onto a full token half. */
export function tokensFromBase16(scheme: Base16Scheme, half: Half = scheme.half): Tokens {
  const mapping = BASE16_MAPPING[half];
  const given: Partial<Record<TokenName, string>> = {};
  for (const [token, slot] of Object.entries(mapping) as [RequiredToken, Base16Slot][]) {
    given[token] = scheme.colors[slot];
  }
  const accent = parseHex(scheme.colors.base0D) as Rgb;
  const dark = parseHex(scheme.colors.base00) as Rgb;
  const light = parseHex(scheme.colors.base07) as Rgb;
  given["accent-fg"] =
    contrast(accent, dark) >= contrast(accent, light) ? scheme.colors.base00 : scheme.colors.base07;
  return completeTokens(given, half);
}

/**
 * Build a Palette from one or two base16 schemes. With one scheme the other
 * half mirrors it, so the palette is complete whichever mode is on.
 */
export function paletteFromBase16(
  schemes: { light?: string; dark?: string },
  name?: string,
): PaletteResult {
  const parsed: Partial<Record<Half, Base16Scheme>> = {};
  const problems: PaletteProblem[] = [];
  for (const half of ["light", "dark"] as const) {
    const text = schemes[half];
    if (text === undefined) continue;
    const result = parseBase16(text);
    if (result.ok) parsed[half] = result.scheme;
    else problems.push(...result.problems.map((p) => ({ ...p, half })));
  }
  if (problems.length > 0) return { ok: false, problems };
  const any = parsed.light ?? parsed.dark;
  if (!any)
    return {
      ok: false,
      problems: [{ half: null, token: null, message: "No base16 scheme given" }],
    };
  const lightScheme = parsed.light ?? (parsed.dark as Base16Scheme);
  const darkScheme = parsed.dark ?? (parsed.light as Base16Scheme);
  return {
    ok: true,
    palette: {
      name: name ?? (any.name || "base16"),
      light: tokensFromBase16(lightScheme, "light"),
      dark: tokensFromBase16(darkScheme, "dark"),
    },
  };
}

/* ------------------------------ Files ------------------------------ */

/**
 * Read a palette file of either shape. A `.yaml` or `.yml` path, or text that
 * names base16 slots, is one base16 scheme (its other half mirrors it); anything
 * else is token TOML. The name falls back to the file's stem.
 */
export function parsePaletteFile(text: string, path = ""): PaletteResult {
  const stem =
    path
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, "") || "custom";
  const yaml = /\.ya?ml$/i.test(path);
  const base16 = yaml || (!/\.toml$/i.test(path) && /^\s*-?\s*base0[0-9A-Fa-f]\s*:/m.test(text));
  if (base16) {
    const result = parseBase16(text);
    if (!result.ok) return result;
    const half = result.scheme.half;
    return paletteFromBase16({ [half]: text }, result.scheme.name || stem);
  }
  return parsePaletteToml(text, stem);
}
