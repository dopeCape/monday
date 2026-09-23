import { describe, expect, test } from "bun:test";
import { PRESETS } from "../domain.ts";
import {
  conditionHolds,
  conditionsOf,
  defaultSettings,
  describeSetting,
  groupMeta,
  groupsInSection,
  isSettingKey,
  isStringKey,
  keyConditions,
  keysInSection,
  SETTING_GROUPS,
  SETTING_SECTIONS,
  type SettingEntry,
  type SettingKey,
  satisfyingValue,
  settingGroup,
  settingKeys,
  settingScope,
  settingSection,
  settingsSchema,
  settingTier,
  settingVisible,
  TASKS,
  unmetConditions,
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

  test("keys sort into their group's tiers, more by default, and a panel group may hold no keys", () => {
    const briefs = groupsInSection("routing").find((g) => g.name === "Briefs");
    expect(briefs?.primary).toEqual(["briefs.policy_mode", "briefs.background"]);
    expect(briefs?.more).toContain("briefs.policy");
    expect(briefs?.keys).toEqual([...(briefs?.primary ?? []), ...(briefs?.more ?? [])]);
    expect(briefs?.advanced).toContain("briefs.bullets_max");
    expect(settingTier("briefs.policy")).toBe("more");
    expect(settingTier("appearance.mode")).toBe("primary");
    const meter = groupsInSection("ai").find((g) => g.name === "Meter");
    expect(meter).toEqual({ name: "Meter", keys: [], primary: [], more: [], advanced: [] });
  });

  test("a section opens with at most seven primary controls, on a fresh install and on the Hosted runtime", () => {
    for (const over of [{}, { "ai.mode": "hosted" }]) {
      const values = { ...defaultSettings(), ...over };
      for (const section of SETTING_SECTIONS) {
        const counted = groupsInSection(section)
          .flatMap((g) => g.primary)
          .filter((k) => settingVisible(k, values))
          // The providers other than the chosen one fold to one row.
          .filter((k) => !/^ai\.(share_key|roles)\.(gemini|openai|kimi|openrouter)$/.test(k));
        expect(counted.length, `${section}: ${counted.join(", ")}`).toBeLessThanOrEqual(7);
      }
    }
  });
});

describe("dependencies (visibleWhen)", () => {
  const values = (over: Record<string, unknown> = {}) => ({ ...defaultSettings(), ...over });

  test("each test of a condition: equals, in, truthy and matches", () => {
    expect(conditionHolds({ key: "k", equals: "custom" }, "custom")).toBe(true);
    expect(conditionHolds({ key: "k", equals: "custom" }, "none")).toBe(false);
    expect(conditionHolds({ key: "k", in: ["rule", "judge"] }, "judge")).toBe(true);
    expect(conditionHolds({ key: "k", in: ["rule", "judge"] }, "model")).toBe(false);
    expect(conditionHolds({ key: "k", truthy: true }, "https://x")).toBe(true);
    expect(conditionHolds({ key: "k", truthy: true }, "")).toBe(false);
    expect(conditionHolds({ key: "k", truthy: true }, [])).toBe(false);
    expect(conditionHolds({ key: "k", truthy: false }, false)).toBe(true);
    expect(conditionHolds({ key: "k", matches: "[/.~]" }, "~/p.toml")).toBe(true);
    expect(conditionHolds({ key: "k", matches: "[/.~]" }, "graphite")).toBe(false);
  });

  test("a child follows its parent's choice, and a chain is followed to the root", () => {
    expect(settingVisible("calendar.custom_link", values())).toBe(false);
    expect(
      settingVisible("calendar.custom_link", values({ "calendar.meeting_link": "custom" })),
    ).toBe(true);
    // The chosen CLI's model shows only under the Local runtime and for that CLI.
    expect(settingVisible("ai.local.model.claude-code", values())).toBe(true);
    expect(settingVisible("ai.local.model.codex", values())).toBe(false);
    const hosted = values({ "ai.mode": "hosted", "ai.local.cli": "codex" });
    expect(settingVisible("ai.local.model.codex", hosted)).toBe(false);
    expect(unmetConditions(keyConditions("ai.local.model.codex"), hosted)).toEqual([
      { key: "ai.mode", equals: "local" },
    ]);
    // A provider's keys follow the group's condition: the Hosted runtime.
    expect(keyConditions("ai.pricing.gemini")).toContainEqual({ key: "ai.mode", equals: "hosted" });
    expect(settingVisible("ai.share_key.gemini", values())).toBe(false);
    expect(settingVisible("ai.share_key.gemini", hosted)).toBe(true);
    // Brief thresholds only in judge mode; the prompt only in model mode.
    expect(settingVisible("briefs.judge.always_at_least", values())).toBe(true);
    expect(settingVisible("briefs.prompt", values())).toBe(false);
    expect(settingVisible("briefs.prompt", values({ "briefs.policy_mode": "model" }))).toBe(true);
    expect(settingVisible("routing.threshold.route", values({ "routing.on_arrival": false }))).toBe(
      false,
    );
  });

  test("every dependency names a real key and can be satisfied", () => {
    for (const key of settingKeys) {
      for (const c of keyConditions(key)) {
        expect(isSettingKey(c.key), `${key} depends on ${c.key}`).toBe(true);
        expect(c.key === key, key).toBe(false);
        const v = satisfyingValue(c);
        if (v) {
          expect(conditionHolds(c, v.value), `${key}: ${JSON.stringify(c)}`).toBe(true);
          expect(validateSetting(c.key as SettingKey, v.value).ok, `${key}: ${c.key}`).toBe(true);
        } else {
          // A free value (a URL, a palette path): the test's own example must pass the schema.
          expect(["server.url", "appearance.palette"], key).toContain(c.key);
        }
      }
    }
  });

  test("the Hosted providers fold into Other providers unless chosen, and keep their Advanced", () => {
    const meta = groupMeta("ai", "Gemini");
    expect(meta.fold?.into).toBe("Other providers");
    expect(meta.ownAdvanced).toBe(true);
    expect(conditionsOf(meta.fold?.openWhen)).toEqual([
      { key: "ai.hosted.provider", equals: "gemini" },
    ]);
    expect(groupMeta("ai", "TypeSafe").ownAdvanced).toBe(true);
    expect(groupMeta("appearance", "Theme")).toEqual({});
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
