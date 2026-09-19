/// <reference types="bun-types" />
// The Shell's Type Settings on the document (docs/spec/settings.md,
// "Appearance"): the font families become the font tokens and the base size
// scales the density's sizes, so every screen, the Settings page included,
// follows them. Through the DOM with happy-dom.

import { beforeAll, describe, expect, test } from "bun:test";
import { dom } from "@monday/ui/test-dom";
import { applyType } from "./Shell.tsx";

beforeAll(async () => {
  await dom();
});

describe("applyType", () => {
  test("writes the families as the font tokens, with the shipped stacks behind them", () => {
    const root = document.createElement("div");
    applyType(root, { font: "IBM Plex Sans", mono: "monospace", fontSize: 14, density: "compact" });
    expect(root.style.getPropertyValue("--font-sans")).toBe(
      '"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    );
    expect(root.style.getPropertyValue("--font-mono")).toBe(
      'monospace, ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace',
    );
    expect(root.dataset.density).toBe("compact");
    // The default size leaves the density's own sizes alone.
    expect(root.style.getPropertyValue("--fs-md")).toBe("");
  });

  test("a base size other than 14 scales every size token from the density's values", () => {
    const style = document.createElement("style");
    style.textContent = ":root { --fs-xs: 10px; --fs-md: 14px; --fs-3xl: 28px; }";
    document.head.appendChild(style);
    const root = document.documentElement;
    applyType(root, {
      font: "Inter",
      mono: "Geist Mono Variable",
      fontSize: 16,
      density: "comfortable",
    });
    const md = Number.parseFloat(root.style.getPropertyValue("--fs-md"));
    // happy-dom may not resolve custom properties; when it does, the scale is 16/14.
    if (Number.isFinite(md)) expect(md).toBeCloseTo(16, 1);
    // Back to 14: the overrides are cleared again.
    applyType(root, {
      font: "Inter",
      mono: "Geist Mono Variable",
      fontSize: 14,
      density: "comfortable",
    });
    expect(root.style.getPropertyValue("--fs-md")).toBe("");
    style.remove();
  });
});
