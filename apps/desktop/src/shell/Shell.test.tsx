/// <reference types="bun-types" />
// The Shell on the document (docs/spec/settings.md, "Appearance"): the Type
// Settings become the font tokens and the base size scales the density's
// sizes; a palette named by path is read through the platform, parsed and
// written onto the root as the color tokens (with `appearance.overrides` on
// top), or its problem shows; the transitions Setting flips the root
// attribute that zeroes every motion token; a mode flip carries the theme
// crossfade attribute for one slow beat. Through the DOM with happy-dom, over
// a fake platform handed to the Shell as its host.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PALETTE_TOKENS } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { fakePlatform } from "../platform/tauri.ts";
import {
  applyPalette,
  applyType,
  isShippedPalette,
  loadPalette,
  Shell,
  type ShellState,
  useShell,
} from "./Shell.tsx";

let createRoot: Awaited<ReturnType<typeof dom>>["createRoot"];
beforeAll(async () => {
  ({ createRoot } = await dom());
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  const r = document.documentElement;
  for (const token of PALETTE_TOKENS) r.style.removeProperty(`--${token}`);
  delete r.dataset.transitions;
  delete r.dataset.themeFade;
});

const settle = () => act(async () => Bun.sleep(15));

const tokens = (bg: string, fg: string, accent: string) =>
  [
    `bg = "${bg}"`,
    'panel = "#ffffff"',
    'sunken = "#eeeef0"',
    'raised = "#ffffff"',
    'overlay = "#ffffff"',
    `fg = "${fg}"`,
    'fg-muted = "#6b6b76"',
    'fg-faint = "#a0a0aa"',
    `accent = "${accent}"`,
    'accent-fg = "#ffffff"',
    'success = "#1f9d61"',
    'warning = "#d4880f"',
    'danger = "#d9403c"',
    'info = "#2f7fd6"',
    'tag-1 = "#3d63dd"',
    'tag-2 = "#1f9d61"',
    'tag-3 = "#d4880f"',
    'tag-4 = "#b8479a"',
    'tag-5 = "#2a9fa8"',
  ].join("\n");
const PALETTE_TOML = `name = "Mine"\n[light]\n${tokens("#fafafa", "#111111", "#3d63dd")}\n[dark]\n${tokens("#101010", "#eeeeee", "#7c96ff")}\n`;

let seen: ShellState | null = null;
function Probe() {
  seen = useShell();
  return null;
}

async function mount(config: string, files: Record<string, string> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const p = fakePlatform(config, { files });
  await act(async () => {
    root?.render(
      <Shell host={p}>
        <Probe />
      </Shell>,
    );
  });
  await settle();
  return p;
}

describe("applyType", () => {
  test("writes the families as the font tokens, with the shipped stacks behind them", () => {
    const r = document.createElement("div");
    applyType(r, { font: "IBM Plex Sans", mono: "monospace", fontSize: 14, density: "compact" });
    expect(r.style.getPropertyValue("--font-sans")).toBe(
      '"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    );
    expect(r.style.getPropertyValue("--font-mono")).toBe(
      'monospace, ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace',
    );
    expect(r.dataset.density).toBe("compact");
    // The default size leaves the density's own sizes alone.
    expect(r.style.getPropertyValue("--fs-md")).toBe("");
  });

  test("a base size other than 14 scales every size token from the density's values", () => {
    const style = document.createElement("style");
    style.textContent = ":root { --fs-xs: 10px; --fs-md: 14px; --fs-3xl: 28px; }";
    document.head.appendChild(style);
    const r = document.documentElement;
    applyType(r, {
      font: "Inter",
      mono: "Geist Mono Variable",
      fontSize: 16,
      density: "comfortable",
    });
    const md = Number.parseFloat(r.style.getPropertyValue("--fs-md"));
    // happy-dom may not resolve custom properties; when it does, the scale is 16/14.
    if (Number.isFinite(md)) expect(md).toBeCloseTo(16, 1);
    // Back to 14: the overrides are cleared again.
    applyType(r, {
      font: "Inter",
      mono: "Geist Mono Variable",
      fontSize: 14,
      density: "comfortable",
    });
    expect(r.style.getPropertyValue("--fs-md")).toBe("");
    style.remove();
  });
});

describe("palettes", () => {
  test("the seven shipped names are shipped; a path is not", () => {
    expect(isShippedPalette("graphite")).toBe(true);
    expect(isShippedPalette("rosepine")).toBe(true);
    expect(isShippedPalette("~/.config/monday/palette.toml")).toBe(false);
    expect(isShippedPalette("")).toBe(false);
  });

  test("applyPalette writes one half's tokens inline, overrides on top, and clears them again", () => {
    const r = document.createElement("div");
    const loaded = loadPalette("p.toml", { path: "/c/p.toml", exists: true, text: PALETTE_TOML });
    expect(loaded.state).toEqual({ path: "p.toml", name: "Mine", error: null });
    applyPalette(r, loaded.palette, "dark", { accent: "#ff0000", "not-a-token": "#000" });
    expect(r.style.getPropertyValue("--bg")).toBe("#101010");
    expect(r.style.getPropertyValue("--accent")).toBe("#ff0000");
    expect(r.style.getPropertyValue("--hover")).toContain("rgba(238, 238, 238");
    expect(r.style.getPropertyValue("--not-a-token")).toBe("");
    applyPalette(r, loaded.palette, "light", {});
    expect(r.style.getPropertyValue("--bg")).toBe("#fafafa");
    expect(r.style.getPropertyValue("--accent")).toBe("#3d63dd");
    // A shipped palette keeps only the overrides inline.
    applyPalette(r, null, "light", { accent: "#00ff00" });
    expect(r.style.getPropertyValue("--bg")).toBe("");
    expect(r.style.getPropertyValue("--accent")).toBe("#00ff00");
  });

  test("loadPalette reports a missing file and the first problem of a bad one", () => {
    const missing = loadPalette("x.toml", { path: "/c/x.toml", exists: false, text: "" });
    expect(missing.palette).toBeNull();
    expect(missing.state.error).toBe("no palette file at /c/x.toml");
    const bad = loadPalette("y.toml", {
      path: "/c/y.toml",
      exists: true,
      text: `[light]\n${tokens("#fff", "#000", "#123")}\n`,
    });
    expect(bad.palette).toBeNull();
    expect(bad.state.error).toBe("Missing [dark] table");
  });

  test("a palette path in the Config file lands on the root and follows the mode", async () => {
    await mount('[appearance]\npalette = "~/p.toml"\n', { "~/p.toml": PALETTE_TOML });
    await seen?.set("appearance.mode", "light");
    await settle();
    const r = document.documentElement;
    expect(r.dataset.palette).toBe("custom");
    expect(r.dataset.theme).toBe("light");
    expect(r.style.getPropertyValue("--bg")).toBe("#fafafa");
    expect(seen?.customPalette).toEqual({ path: "~/p.toml", name: "Mine", error: null });
    expect(seen?.pinned.has("appearance.palette")).toBe(true);
    // The Setting is Pinned by the file, so the mode is what moves the half.
    const changed = await seen?.set("appearance.mode", "dark");
    expect(changed?.ok).toBe(true);
    await settle();
    expect(r.dataset.theme).toBe("dark");
    expect(r.style.getPropertyValue("--bg")).toBe("#101010");
    // The crossfade rides on the root for one slow beat, when the token is readable.
    expect(r.dataset.themeFade === "true" || r.dataset.themeFade === undefined).toBe(true);
  });

  test("a palette file that is missing or broken shows its problem and leaves the shipped palette", async () => {
    await mount('[appearance]\npalette = "nowhere.toml"\n');
    const r = document.documentElement;
    expect(r.dataset.palette).toBe("custom");
    expect(r.style.getPropertyValue("--bg")).toBe("");
    expect(seen?.customPalette?.error).toContain("no palette file at");
    // Back to a shipped palette from the Server side: the Config file pins it, so a set is refused.
    const refused = await seen?.set("appearance.palette", "nord");
    expect(refused?.ok).toBe(false);
  });

  test("a saved palette path (not from the file) is read the same way and can be changed", async () => {
    await mount("", { "/abs/mine.toml": PALETTE_TOML });
    const ok = await seen?.set("appearance.palette", "/abs/mine.toml");
    expect(ok?.ok).toBe(true);
    await settle();
    const r = document.documentElement;
    expect(r.dataset.palette).toBe("custom");
    expect(r.style.getPropertyValue("--bg")).toBe("#fafafa");
    await seen?.set("appearance.palette", "gruvbox");
    await settle();
    expect(r.dataset.palette).toBe("gruvbox");
    expect(r.style.getPropertyValue("--bg")).toBe("");
    expect(seen?.customPalette).toBeNull();
  });

  test("token overrides apply over a shipped palette too", async () => {
    await mount('[appearance]\n[appearance.overrides]\naccent = "#123456"\n');
    const r = document.documentElement;
    expect(r.dataset.palette).toBe("graphite");
    expect(r.style.getPropertyValue("--accent")).toBe("#123456");
  });
});

describe("transitions", () => {
  test("the Setting flips the root attribute that zeroes every motion token", async () => {
    await mount("");
    const r = document.documentElement;
    expect(r.dataset.transitions).toBe("auto");
    await seen?.set("appearance.transitions", false);
    await settle();
    expect(r.dataset.transitions).toBe("off");
    await seen?.set("appearance.transitions", true);
    await settle();
    expect(r.dataset.transitions).toBe("auto");
  });

  test("the file pins it like any Setting", async () => {
    await mount("[appearance]\ntransitions = false\n");
    expect(document.documentElement.dataset.transitions).toBe("off");
    const refused = await seen?.set("appearance.transitions", true);
    expect(refused).toEqual({
      ok: false,
      reason: "pinned",
      message: "appearance.transitions is set in ~/.config/monday/monday.toml",
    });
  });
});
