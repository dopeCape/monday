/// <reference types="bun-types" />
// ThemeProvider writes the knobs onto the document root. Needs a DOM, so this
// file registers happy-dom and renders through react-dom/client.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PRESETS } from "@monday/shared";
import { act } from "react";
import type { Root } from "react-dom/client";
import { dom } from "./test-dom.ts";
import {
  applyThemeAttributes,
  presetName,
  resolveMode,
  ThemeProvider,
  type ThemeRoot,
  themeAttributes,
} from "./theme.tsx";

let createRoot: Awaited<ReturnType<typeof dom>>["createRoot"];
beforeAll(async () => {
  ({ createRoot } = await dom());
});

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
});

async function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  await act(async () => r.render(node));
}

const attr = (name: string) => document.documentElement.getAttribute(name);

describe("ThemeProvider", () => {
  test("sets the data attributes on the document root", async () => {
    await mount(
      <ThemeProvider mode="light" palette="nord" density="spacious" layout={PRESETS.columns}>
        <span />
      </ThemeProvider>,
    );
    expect(attr("data-theme")).toBe("light");
    expect(attr("data-palette")).toBe("nord");
    expect(attr("data-density")).toBe("spacious");
    expect(attr("data-layout")).toBe("columns");
    expect(attr("data-nav")).toBe("full");
    expect(attr("data-agent")).toBe("bottom");
    expect(attr("data-list")).toBe("split");
  });

  test("updates the attributes when the props change", async () => {
    await mount(
      <ThemeProvider
        mode="dark"
        palette="graphite"
        density="comfortable"
        layout={PRESETS.stream}
      />,
    );
    expect(attr("data-theme")).toBe("dark");
    expect(attr("data-list")).toBe("stream");
    const r = root;
    if (!r) throw new Error("no root");
    await act(async () =>
      r.render(
        <ThemeProvider
          mode="dark"
          palette="everforest"
          density="compact"
          layout={{ nav: "hidden", agent: "right", list: "stream" }}
        />,
      ),
    );
    expect(attr("data-palette")).toBe("everforest");
    expect(attr("data-density")).toBe("compact");
    expect(attr("data-layout")).toBe("custom");
    expect(attr("data-nav")).toBe("hidden");
    expect(attr("data-agent")).toBe("right");
  });

  test("resolves system mode with matchMedia", async () => {
    const original = window.matchMedia;
    const listeners = new Set<() => void>();
    let dark = true;
    window.matchMedia = ((query: string) =>
      ({
        media: query,
        get matches() {
          return dark;
        },
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      await mount(
        <ThemeProvider
          mode="system"
          palette="graphite"
          density="comfortable"
          layout={PRESETS.stream}
        />,
      );
      expect(attr("data-theme")).toBe("dark");
      dark = false;
      await act(async () => {
        for (const fn of listeners) fn();
      });
      expect(attr("data-theme")).toBe("light");
    } finally {
      window.matchMedia = original;
    }
  });

  test("writes to a custom root when given one", async () => {
    const written: Record<string, string> = {};
    const fake: ThemeRoot = { setAttribute: (n, v) => (written[n] = v) };
    await mount(
      <ThemeProvider
        mode="light"
        palette="rosepine"
        density="comfortable"
        layout={PRESETS["agent-left"]}
        root={fake}
      />,
    );
    expect(written).toEqual({
      "data-theme": "light",
      "data-palette": "rosepine",
      "data-density": "comfortable",
      "data-layout": "agent-left",
      "data-nav": "rail",
      "data-agent": "left",
      "data-list": "split",
    });
  });
});

describe("theme helpers", () => {
  test("presetName finds the preset or says custom", () => {
    expect(presetName(PRESETS.stream)).toBe("stream");
    expect(presetName(PRESETS.columns)).toBe("columns");
    expect(presetName(PRESETS["agent-left"])).toBe("agent-left");
    expect(presetName({ nav: "hidden", agent: "bottom", list: "stream" })).toBe("custom");
  });

  test("resolveMode only consults the system preference for system", () => {
    expect(resolveMode("system", true)).toBe("dark");
    expect(resolveMode("system", false)).toBe("light");
    expect(resolveMode("light", true)).toBe("light");
    expect(resolveMode("dark", false)).toBe("dark");
  });

  test("applyThemeAttributes writes every attribute", () => {
    const written: Record<string, string> = {};
    applyThemeAttributes(
      { setAttribute: (n, v) => (written[n] = v) },
      themeAttributes(
        { mode: "system", palette: "tokyonight", density: "compact", layout: PRESETS.columns },
        true,
      ),
    );
    expect(Object.keys(written).length).toBe(7);
    expect(written["data-theme"]).toBe("dark");
    expect(written["data-palette"]).toBe("tokyonight");
  });
});
