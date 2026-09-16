import { describe, expect, test } from "bun:test";
import { parse as parseToml } from "smol-toml";
import { editConfigKey, formatValue } from "./edit.ts";
import { mockConfigFixed } from "./parse.test.ts";
import { parseConfig } from "./parse.ts";

const sample = `# ~/.config/monday/monday.toml
# Reloaded live.

[appearance]
theme     = "system"       # light | dark | system
palette   = "gruvbox"      # or path to a custom palette file
font_size = 14

[layout]
nav       = "full"         # full | rail | hidden
sections  = ["needs-reply", "waiting",
             "fyi", "newsletters"]

[ai]
mode      = "local"        # api | local
local.cli = "claude-code"
`;

describe("editConfigKey", () => {
  test("replaces an existing value and keeps spacing and the trailing comment", () => {
    const out = editConfigKey(sample, "appearance.palette", "nord");
    expect(out).toContain('palette   = "nord"      # or path to a custom palette file');
    const changed = out.split("\n").filter((line, i) => line !== sample.split("\n")[i]);
    expect(changed).toHaveLength(1);
  });

  test("changes only that key: every other byte survives", () => {
    const out = editConfigKey(sample, "appearance.font_size", 16);
    const before = sample.split("\n");
    const after = out.split("\n");
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      if (before[i]?.startsWith("font_size")) expect(after[i]).toBe("font_size = 16");
      else expect(after[i]).toBe(before[i]);
    }
  });

  test("replaces a multi-line array with one line and keeps what follows", () => {
    const out = editConfigKey(sample, "layout.sections", ["fyi", "waiting"]);
    expect(out).toContain('sections  = ["fyi", "waiting"]\n\n[ai]');
    expect(out).not.toContain("newsletters");
    expect(out).toContain("# Reloaded live.");
  });

  test("adds a missing key at the end of its table", () => {
    const out = editConfigKey(sample, "appearance.density", "compact");
    expect(out).toContain('font_size = 14\ndensity = "compact"\n\n[layout]');
  });

  test("adds a dotted key under the closest enclosing table", () => {
    const out = editConfigKey(sample, "ai.hosted.provider", "openai");
    expect(out.endsWith('local.cli = "claude-code"\nhosted.provider = "openai"\n')).toBe(true);
  });

  test("adds a new table at the end when none encloses the key", () => {
    const out = editConfigKey(sample, "routing.threshold.route", 0.9);
    expect(out.endsWith('local.cli = "claude-code"\n\n[routing.threshold]\nroute = 0.9\n')).toBe(
      true,
    );
    expect(out.startsWith(sample.trimEnd())).toBe(true);
  });

  test("adds a root key after the leading comments and before the first table", () => {
    const out = editConfigKey(sample, "schema", 1);
    expect(
      out.startsWith(
        "# ~/.config/monday/monday.toml\n# Reloaded live.\n\nschema = 1\n\n[appearance]",
      ),
    ).toBe(true);
  });

  test("writes into an inline table without touching sibling keys", () => {
    const text = `[ai]\nroles.anthropic = { main = "claude-sonnet-5", fast = "claude-haiku-4-5" } # roles\n`;
    const out = editConfigKey(text, "ai.roles.anthropic.main", "claude-opus-5");
    expect(out).toBe(
      `[ai]\nroles.anthropic = { main = "claude-opus-5", fast = "claude-haiku-4-5" } # roles\n`,
    );
  });

  test("an edit of a fresh file is a bare key or a table", () => {
    expect(editConfigKey("", "schema", 1)).toBe("schema = 1\n");
    expect(editConfigKey("", "appearance.mode", "dark")).toBe('[appearance]\nmode = "dark"\n');
  });

  test("the result is valid TOML that parseConfig applies", () => {
    let text = mockConfigFixed;
    text = editConfigKey(text, "appearance.palette", "nord");
    text = editConfigKey(text, "routing.threshold.route", 0.75);
    text = editConfigKey(text, "views.focus.list", "split");
    text = editConfigKey(text, "appearance.overrides.fg", "#ebdbb2");
    expect(() => parseToml(text)).not.toThrow();
    const result = parseConfig(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["appearance.palette"]).toBe("nord");
      expect(result.values["routing.threshold.route"]).toBe(0.75);
      expect(result.values["views.list"]?.[0]?.layout.list).toBe("split");
      expect(result.values["appearance.overrides"]).toEqual({
        accent: "#fe8019",
        bg: "#1d2021",
        fg: "#ebdbb2",
      });
    }
    // Comments survive every edit.
    expect(text).toContain("# a view pinned from the file");
    expect(text).toContain("# light | dark | system");
  });

  test("formatValue writes strings, numbers, booleans, arrays and inline tables", () => {
    expect(formatValue('say "hi"\n')).toBe('"say \\"hi\\"\\n"');
    expect(formatValue(0.5)).toBe("0.5");
    expect(formatValue(true)).toBe("true");
    expect(formatValue([1, "a"])).toBe('[1, "a"]');
    expect(formatValue({ main: "x", "odd key": 2 })).toBe('{ main = "x", "odd key" = 2 }');
    expect(formatValue({})).toBe("{}");
  });
});
