import { describe, expect, test } from "bun:test";
import { PRESETS } from "../domain.ts";
import {
  defaultSettings,
  describeSetting,
  groupsInSection,
  isSettingKey,
  isStringKey,
  keysInSection,
  SETTING_GROUPS,
  SETTING_SECTIONS,
  type SettingEntry,
  type SettingKey,
  settingGroup,
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

describe("settings screen metadata (slice 17)", () => {
  test("every key that is not a string lands in exactly one group of its section, or says why it is hidden", () => {
    const seen = new Map<string, number>();
    for (const section of SETTING_SECTIONS) {
      for (const group of groupsInSection(section)) {
        for (const key of [...group.keys, ...group.advanced]) {
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
      }
    }
    for (const key of settingKeys) {
      if (isStringKey(key)) {
        expect(seen.has(key), key).toBe(false);
        continue;
      }
      const entry = settingsSchema[key] as SettingEntry;
      if (entry.hidden) {
        expect(entry.hidden.length, key).toBeGreaterThan(0);
        expect(seen.has(key), key).toBe(false);
      } else if (entry.renderedBy) {
        expect(isSettingKey(entry.renderedBy), key).toBe(true);
        expect(settingSection(entry.renderedBy as SettingKey), key).toBe(entry.section);
        expect(seen.has(key), key).toBe(false);
      } else {
        expect(seen.get(key), key).toBe(1);
      }
    }
  });

  test("groups follow SETTING_GROUPS, and a key without metadata gets a group from its prefix", () => {
    const names = groupsInSection("appearance").map((g) => g.name);
    expect(names.slice(0, SETTING_GROUPS.appearance.length)).toEqual([
      ...SETTING_GROUPS.appearance,
    ]);
    expect(settingGroup("appearance.mode")).toBe("Theme");
    expect(settingGroup("keyboard.keymap")).toBe("Keymap");
  });

  test("advanced keys fold under their group and a panel group may hold no keys", () => {
    const briefs = groupsInSection("routing").find((g) => g.name === "Briefs");
    expect(briefs?.keys).toContain("briefs.policy");
    expect(briefs?.advanced).toContain("briefs.bullets_max");
    const meter = groupsInSection("ai").find((g) => g.name === "Meter");
    expect(meter).toEqual({ name: "Meter", keys: [], advanced: [] });
  });

  test("describeSetting reads the control shape out of the zod type", () => {
    expect(describeSetting("appearance.mode")).toEqual({
      kind: "enum",
      options: ["system", "light", "dark"],
    });
    expect(describeSetting("appearance.font_size")).toEqual({
      kind: "number",
      integer: true,
      min: 10,
      max: 24,
    });
    expect(describeSetting("routing.threshold.route")).toEqual({
      kind: "number",
      integer: false,
      min: 0,
      max: 1,
    });
    expect(describeSetting("briefs.background")).toEqual({ kind: "boolean" });
    expect(describeSetting("ai.endpoint.kimi")).toEqual({
      kind: "string",
      url: true,
      maxLength: null,
    });
    expect(describeSetting("agent.system_prompt")).toEqual({
      kind: "string",
      url: false,
      maxLength: 20_000,
    });
    expect(describeSetting("briefs.automated_senders")).toEqual({
      kind: "list",
      item: { kind: "string", url: false, maxLength: null },
    });
    expect(describeSetting("inbox.snooze_presets")).toMatchObject({
      kind: "list",
      item: { kind: "enum" },
    });
    expect(describeSetting("briefs.policy_groups")).toEqual({
      kind: "record",
      value: { kind: "enum", options: ["always", "on_open", "never"] },
    });
    expect(describeSetting("ai.roles.anthropic")).toEqual({ kind: "json" });
    expect(describeSetting("inbox.rows")).toEqual({ kind: "json" });
  });
});
