import { describe, expect, test } from "bun:test";
import { PRESETS } from "../domain.ts";
import {
  defaultSettings,
  isSettingKey,
  keysInSection,
  SETTING_SECTIONS,
  settingKeys,
  settingScope,
  settingSection,
  settingsSchema,
  TASKS,
  validateSetting,
} from "./index.ts";

describe("settings schema", () => {
  test("every default validates against its own type", () => {
    for (const key of settingKeys) {
      const result = validateSetting(key, settingsSchema[key].default);
      expect(result.ok, `${key}: ${result.ok ? "" : result.error}`).toBe(true);
    }
  });

  test("every key has a scope, a section, a label and help", () => {
    for (const key of settingKeys) {
      const entry = settingsSchema[key];
      expect(["global", "device"]).toContain(entry.scope);
      expect(SETTING_SECTIONS).toContain(entry.section);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.help.length).toBeGreaterThan(0);
      expect(settingScope(key)).toBe(entry.scope);
      expect(settingSection(key)).toBe(entry.section);
    }
  });

  test("keys are dotted and snake_case so they map onto monday.toml", () => {
    for (const key of settingKeys) {
      expect(key).toMatch(/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/);
    }
  });

  test("no user-visible text contains an em-dash", () => {
    for (const key of settingKeys) {
      const entry = settingsSchema[key];
      const text = [entry.label, entry.help, JSON.stringify(entry.default)].join(" ");
      expect(text).not.toContain(String.fromCharCode(0x2014));
    }
  });

  test("defaultSettings returns a fresh copy", () => {
    const a = defaultSettings();
    const b = defaultSettings();
    a["sections.order"].push("extra");
    expect(b["sections.order"]).toEqual(["needs-reply", "waiting", "fyi", "newsletters"]);
  });

  test("the defaults the specs name", () => {
    const d = defaultSettings();
    expect(d["routing.threshold.route"]).toBe(0.8);
    expect(d["routing.threshold.ask"]).toBe(0.5);
    expect(d["routing.threshold.tie_margin"]).toBe(0.1);
    expect(d["routing.decisions.cap"]).toBe(20);
    expect(d["routing.lookback_days"]).toBe(90);
    expect(d["briefs.bullets_max"]).toBe(3);
    expect(d["briefs.actions_max"]).toBe(3);
    expect(d["briefs.policy"]).toContain("Needs your reply and Waiting on you always");
    expect(d["send.delay_seconds"]).toBe(30);
    expect(d["search.cache_window_days"]).toBe(730);
    expect(d["search.cache_cap_gb"]).toBe(2);
    expect(d["search.prewarm_on_metered"]).toBe(false);
    expect(d["search.prewarm_on_battery"]).toBe(false);
    expect(d["ai.roles.anthropic"]).toEqual({ main: "claude-sonnet-5", fast: "claude-haiku-4-5" });
    expect(d["ai.developer_mode_default"]).toBe(false);
    expect(d["ai.web_fetch"]).toBe(false);
    expect(d["workflows.run_retention_days"]).toBe(30);
    expect(d["workflows.budget.tool_calls"]).toBe(25);
    expect(d["workflows.budget.minutes"]).toBe(10);
    expect(d["keyboard.keymap"]).toBe("vim");
    expect(d["notifications.calendar_lead_minutes"]).toBe(10);
    expect(d["server.insecure_allowed"]).toBe(false);
    expect(d["appearance.palette"]).toBe("graphite");
    expect(d["strings.inbox.empty"]).toBe("Nothing needs you");
    expect({ nav: d["layout.nav"], agent: d["layout.agent"], list: d["layout.list"] }).toEqual(
      PRESETS.stream,
    );
  });

  test("every Task has a model entry", () => {
    for (const task of TASKS) expect(isSettingKey(`ai.task.${task}`)).toBe(true);
  });

  test("density and font size are per device", () => {
    expect(settingScope("appearance.density")).toBe("device");
    expect(settingScope("appearance.font_size")).toBe("device");
    expect(settingScope("appearance.palette")).toBe("global");
  });

  test("validateSetting accepts good values and rejects bad ones with a message", () => {
    expect(validateSetting("appearance.mode", "dark")).toEqual({ ok: true, value: "dark" });
    const bad = validateSetting("appearance.mode", "sepia");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("expected one of");
    const range = validateSetting("routing.threshold.route", 1.5);
    expect(range.ok).toBe(false);
    const unknown = validateSetting("nope.nope", 1);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("Unknown setting");
  });

  test("every section has at least one key", () => {
    for (const section of SETTING_SECTIONS) {
      expect(keysInSection(section).length, section).toBeGreaterThan(0);
    }
  });
});
