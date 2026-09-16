import { describe, expect, test } from "bun:test";
import {
  BASE16_SLOTS,
  DERIVED_TOKENS,
  PALETTE_TOKENS,
  paletteFromBase16,
  parseBase16,
  parsePaletteToml,
  REQUIRED_TOKENS,
} from "./palette.ts";

const light = `
bg = "#f4f4f5"
panel = "#ffffff"
sunken = "#eeeef0"
raised = "#ffffff"
overlay = "#ffffff"
fg = "#18181b"
fg-muted = "#6b6b76"
fg-faint = "#a0a0aa"
accent = "#3d63dd"
accent-fg = "#ffffff"
success = "#1f9d61"
warning = "#d4880f"
danger = "#d9403c"
info = "#2f7fd6"
tag-1 = "#3d63dd"
tag-2 = "#1f9d61"
tag-3 = "#d4880f"
tag-4 = "#b8479a"
tag-5 = "#2a9fa8"
`;

const dark = `
bg = "#0c0c0e"
panel = "#131316"
sunken = "#0f0f11"
raised = "#1a1a1f"
overlay = "#1c1c22"
fg = "#ececef"
fg-muted = "#9d9da8"
fg-faint = "#5f5f6a"
accent = "#7c96ff"
accent-fg = "#0c0c0e"
success = "#4ecb8c"
warning = "#e6a63a"
danger = "#f06d6a"
info = "#62a5f5"
tag-1 = "#7c96ff"
tag-2 = "#4ecb8c"
tag-3 = "#e6a63a"
tag-4 = "#d783c0"
tag-5 = "#58c3cb"
hover = "rgba(255, 255, 255, 0.05)"
`;

const tokenToml = `name = "Graphite copy"\n\n[light]${light}\n[dark]${dark}`;

// The default dark scheme from the base16 project.
const base16Dark = `scheme: "Default Dark"
author: "Chris Kempson (http://chriskempson.com)"
base00: "181818"
base01: "282828"
base02: "383838"
base03: "585858"
base04: "b8b8b8"
base05: "d8d8d8"
base06: "e8e8e8"
base07: "f8f8f8"
base08: "ab4642"
base09: "dc9656"
base0A: "f7ca88"
base0B: "a1b56c"
base0C: "86c1b9"
base0D: "7cafc2"
base0E: "ba8baf"
base0F: "a16946"
`;

// The tinted-theming shape: a palette map, hashes and a comment with a hash in it.
const base16Light = `system: "base16"
name: "Default Light"
author: "Chris Kempson"
variant: "light"
palette:
  base00: "#f8f8f8" # default background
  base01: "#e8e8e8"
  base02: "#d8d8d8"
  base03: "#b8b8b8"
  base04: "#585858"
  base05: "#383838"
  base06: "#282828"
  base07: "#181818"
  base08: "#ab4642"
  base09: "#dc9656"
  base0A: "#f7ca88"
  base0B: "#a1b56c"
  base0C: "#86c1b9"
  base0D: "#7cafc2"
  base0E: "#ba8baf"
  base0F: "#a16946"
`;

describe("palette files", () => {
  test("a token TOML with both halves yields a complete palette", () => {
    const result = parsePaletteToml(tokenToml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.palette.name).toBe("Graphite copy");
    for (const half of ["light", "dark"] as const) {
      for (const token of PALETTE_TOKENS) {
        expect(result.palette[half][token], `${half} ${token}`).toBeTruthy();
      }
    }
    expect(result.palette.dark.hover).toBe("rgba(255, 255, 255, 0.05)");
    expect(result.palette.light.hover).toBe("rgba(24, 24, 27, 0.045)");
    expect(result.palette.light.selection).toBe("rgba(61, 99, 221, 0.22)");
    expect(result.palette.dark["shadow-sm"]).toContain("rgba(0, 0, 0, 0.4)");
  });

  test("a missing required token is reported per half", () => {
    const result = parsePaletteToml(
      `[light]${light.replace('accent = "#3d63dd"\n', "")}\n[dark]${dark}`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([
      { half: "light", token: "accent", message: 'Missing token "accent"' },
    ]);
  });

  test("a missing half, an unknown token and a non-color are all problems", () => {
    const result = parsePaletteToml(`[light]${light}\nglow = 3\n`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const messages = result.problems.map((p) => p.message);
    expect(messages).toContain("Missing [dark] table");
    expect(messages).toContain('Unknown token "glow"');
    const badColor = parsePaletteToml(`[light]${light.replace('"#f4f4f5"', "12")}\n[dark]${dark}`);
    expect(badColor.ok).toBe(false);
    if (!badColor.ok) expect(badColor.problems[0]?.message).toBe("bg must be a color string");
  });

  test("a TOML syntax error is one problem", () => {
    const result = parsePaletteToml("[light\nbg = 1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]?.message).toMatch(/^Line 1/);
  });

  test("parseBase16 reads both scheme file shapes and detects the half", () => {
    const d = parseBase16(base16Dark);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.scheme.name).toBe("Default Dark");
      expect(d.scheme.half).toBe("dark");
      expect(d.scheme.colors.base0D).toBe("#7cafc2");
      for (const slot of BASE16_SLOTS) expect(d.scheme.colors[slot]).toMatch(/^#[0-9a-f]{6}$/);
    }
    const l = parseBase16(base16Light);
    expect(l.ok).toBe(true);
    if (l.ok) {
      expect(l.scheme.name).toBe("Default Light");
      expect(l.scheme.half).toBe("light");
      expect(l.scheme.colors.base00).toBe("#f8f8f8");
    }
    const missing = parseBase16(base16Dark.replace('base0F: "a16946"\n', ""));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.problems[0]?.token).toBe("base0F");
  });

  test("base16 maps to a full token set following the documented mapping", () => {
    const result = paletteFromBase16({ dark: base16Dark, light: base16Light });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { palette } = result;
    expect(palette.name).toBe("Default Light");
    for (const half of ["light", "dark"] as const) {
      for (const token of REQUIRED_TOKENS)
        expect(palette[half][token], `${half} ${token}`).toMatch(/^#/);
      for (const token of DERIVED_TOKENS)
        expect(palette[half][token], `${half} ${token}`).toBeTruthy();
    }
    expect(palette.dark.bg).toBe("#181818");
    expect(palette.dark.panel).toBe("#282828");
    expect(palette.dark.fg).toBe("#d8d8d8");
    expect(palette.dark.accent).toBe("#7cafc2");
    expect(palette.dark["accent-fg"]).toBe("#181818");
    expect(palette.dark.danger).toBe("#ab4642");
    expect(palette.dark["tag-4"]).toBe("#ba8baf");
    expect(palette.dark.selection).toBe("rgba(124, 175, 194, 0.3)");
    expect(palette.light.bg).toBe("#e8e8e8");
    expect(palette.light.panel).toBe("#f8f8f8");
    expect(palette.light.sunken).toBe("#d8d8d8");
    expect(palette.light.fg).toBe("#383838");
  });

  test("one base16 scheme fills both halves", () => {
    const result = paletteFromBase16({ dark: base16Dark }, "mine");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.palette.name).toBe("mine");
    expect(result.palette.light.fg).toBe("#d8d8d8");
    expect(Object.keys(result.palette.light).sort()).toEqual([...PALETTE_TOKENS].sort());
  });

  test("no scheme at all is a problem", () => {
    const result = paletteFromBase16({});
    expect(result.ok).toBe(false);
  });
});
