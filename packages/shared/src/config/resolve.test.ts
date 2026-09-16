import { describe, expect, test } from "bun:test";
import { PRESETS } from "../domain.ts";
import { defaultSettings } from "../settings/schema.ts";
import { presetForLayout, resolveSettings } from "./resolve.ts";

describe("resolveSettings", () => {
  test("file wins over database wins over default, and file keys are pinned", () => {
    const { settings, pinned } = resolveSettings(
      { "appearance.palette": "gruvbox" },
      { "appearance.palette": "nord", "appearance.mode": "dark" },
    );
    expect(settings["appearance.palette"]).toBe("gruvbox");
    expect(settings["appearance.mode"]).toBe("dark");
    expect(settings["send.delay_seconds"]).toBe(30);
    expect([...pinned]).toEqual(["appearance.palette"]);
  });

  test("nothing set yields the defaults and no pins", () => {
    const { settings, pinned } = resolveSettings({}, {});
    expect(settings).toEqual(defaultSettings());
    expect(pinned.size).toBe(0);
  });

  test("custom defaults are honored", () => {
    const defaults = { ...defaultSettings(), "keyboard.keymap": "gmail" as const };
    const { settings } = resolveSettings({}, {}, defaults);
    expect(settings["keyboard.keymap"]).toBe("gmail");
  });

  test("the preset is derived from the knobs", () => {
    expect(presetForLayout(PRESETS.columns)).toBe("columns");
    expect(presetForLayout({ nav: "hidden", agent: "right", list: "stream" })).toBe("custom");
    const { settings } = resolveSettings({}, { "layout.list": "split" });
    expect(settings["layout.preset"]).toBe("columns");
  });

  test("a preset set in the file fills and pins the knobs it decides", () => {
    const { settings, pinned } = resolveSettings(
      { "layout.preset": "agent-left", "layout.list": "stream" },
      { "layout.nav": "hidden" },
    );
    expect(settings["layout.nav"]).toBe("rail");
    expect(settings["layout.agent"]).toBe("left");
    expect(settings["layout.list"]).toBe("stream");
    expect(settings["layout.preset"]).toBe("custom");
    expect(pinned.has("layout.nav")).toBe(true);
    expect(pinned.has("layout.agent")).toBe(true);
    expect(pinned.has("layout.list")).toBe(true);
    expect(pinned.has("layout.preset")).toBe(true);
  });

  test("a preset saved in the database yields to knobs saved there", () => {
    const { settings, pinned } = resolveSettings(
      {},
      { "layout.preset": "columns", "layout.nav": "rail" },
    );
    expect(settings["layout.nav"]).toBe("rail");
    expect(settings["layout.list"]).toBe("split");
    expect(settings["layout.preset"]).toBe("custom");
    expect(pinned.size).toBe(0);
  });
});
