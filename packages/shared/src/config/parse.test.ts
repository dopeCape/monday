import { describe, expect, test } from "bun:test";
// @ts-expect-error the design mock is plain JavaScript without types
import { toml as mockToml } from "../../../../design/js/data.js";
import { parseConfig } from "./parse.ts";

/** The example config from the design mock, with its syntax-highlighting spans removed. */
export const mockConfig: string = (mockToml as string).replace(/<[^>]+>/g, "");


function ok(text: string) {
  const result = parseConfig(text);
  if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`);
  return result;
}

describe("parseConfig", () => {
  test("a table that redefines a string key is a syntax error with a line number", () => {
    const broken = mockConfig.replace("[appearance.overrides]", "[appearance.palette.overrides]");
    const result = parseConfig(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.line).toBe(26);
      expect(result.error.message).toContain("redefine");
    }
  });

  test("the design mock parses with known keys applied and unknown ones warned", () => {
    const result = ok(mockConfig);
    expect(result.schema).toBe(1);
    expect(result.values["appearance.mode"]).toBe("system");
    expect(result.values["appearance.palette"]).toBe("gruvbox");
    expect(result.values["appearance.density"]).toBe("comfortable");
    expect(result.values["appearance.font"]).toBe("Geist Variable");
    expect(result.values["appearance.font_size"]).toBe(14);
    expect(result.values["appearance.overrides"]).toEqual({ accent: "#fe8019", bg: "#1d2021" });
    expect(result.values["layout.preset"]).toBe("stream");
    expect(result.values["layout.nav"]).toBe("full");
    expect(result.values["layout.agent"]).toBe("bottom");
    expect(result.values["layout.list"]).toBe("stream");
    expect(result.values["sections.order"]).toEqual([
      "needs-reply",
      "waiting",
      "fyi",
      "newsletters",
    ]);
    expect(result.values["views.list"]).toEqual([
      {
        id: "focus",
        name: "focus",
        shortcut: null,
        layout: { nav: "hidden", agent: "right", list: "stream" },
      },
    ]);
    expect(result.values["ai.mode"]).toBe("local");
    expect(result.values["ai.hosted.provider"]).toBe("anthropic");
    expect(result.values["server.url"]).toBe("https://sync.genai-labs.io");

    const keys = result.warnings.map((w) => w.key).sort();
    expect(keys).toEqual(
      [
        "actions.reader.invoices",
        "ai.api.model",
        "layout.row",
        "server.run_workflows_when_offline",
      ].sort(),
    );
    for (const warning of result.warnings) expect(warning.line).not.toBeNull();
    expect(result.values["ai.local.cli"]).toBe("claude-code");
  });

  test("an unknown key warns with its line and does not apply", () => {
    const result = ok(`[appearance]\nmode = "dark"\nsparkle = true\n`);
    expect(result.values["appearance.mode"]).toBe("dark");
    expect(result.warnings).toEqual([
      { line: 3, key: "appearance.sparkle", message: 'Unknown key "appearance.sparkle"' },
    ]);
  });

  test("a bad value warns and is dropped while the rest applies", () => {
    const result = ok(`[routing.threshold]\nroute = 1.4\nask = 0.6\n`);
    expect(result.values["routing.threshold.route"]).toBeUndefined();
    expect(result.values["routing.threshold.ask"]).toBe(0.6);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.key).toBe("routing.threshold.route");
    expect(result.warnings[0]?.line).toBe(2);
  });

  test("a syntax error returns ok false so the caller keeps the last good config", () => {
    const good = ok(`[appearance]\nmode = "dark"\n`);
    const bad = parseConfig(`[appearance]\nmode = "dark\n`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.line).toBe(2);
      expect(typeof bad.error.message).toBe("string");
    }
    const effective = bad.ok ? bad.values : good.values;
    expect(effective["appearance.mode"]).toBe("dark");
  });

  test("schema = 1 is accepted silently and a newer schema warns", () => {
    expect(ok("schema = 1\n").warnings).toEqual([]);
    expect(ok("schema = 1\n").schema).toBe(1);
    const newer = ok('schema = 2\n[appearance]\nmode = "light"\n');
    expect(newer.schema).toBe(2);
    expect(newer.warnings).toHaveLength(1);
    expect(newer.warnings[0]?.key).toBe("schema");
    expect(newer.warnings[0]?.line).toBe(1);
    expect(newer.values["appearance.mode"]).toBe("light");
    const junk = ok('schema = "one"\n');
    expect(junk.warnings[0]?.message).toContain("whole number");
  });

  test("dotted keys and tables are the same key", () => {
    const a = ok(`routing.threshold.route = 0.9\n`);
    const b = ok(`[routing]\nthreshold.route = 0.9\n`);
    const c = ok(`[routing.threshold]\nroute = 0.9\n`);
    for (const r of [a, b, c]) expect(r.values["routing.threshold.route"]).toBe(0.9);
  });

  test("an object-valued setting takes its whole table", () => {
    const result = ok(`[ai.roles.anthropic]\nmain = "claude-opus-5"\nfast = "claude-haiku-4-5"\n`);
    expect(result.values["ai.roles.anthropic"]).toEqual({
      main: "claude-opus-5",
      fast: "claude-haiku-4-5",
    });
    const partial = ok(`[ai.roles.anthropic]\nmain = "claude-opus-5"\n`);
    expect(partial.values["ai.roles.anthropic"]).toBeUndefined();
    expect(partial.warnings[0]?.line).toBe(1);
  });

  test("a view table may name a preset and a shortcut", () => {
    const result = ok(
      `[views.focus]\npreset = "agent-left"\nlist = "stream"\nshortcut = "cmd+3"\n`,
    );
    expect(result.values["views.list"]).toEqual([
      {
        id: "focus",
        name: "focus",
        shortcut: "cmd+3",
        layout: { nav: "rail", agent: "left", list: "stream" },
      },
    ]);
  });

  test("an empty file is a valid config with no values", () => {
    const result = ok("");
    expect(result.values).toEqual({});
    expect(result.warnings).toEqual([]);
  });
});
