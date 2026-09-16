// Parse monday.toml into validated Settings values plus warnings (ADR 0001).
//
// Rules: unknown keys warn, bad values warn and are dropped, valid keys apply.
// A syntax error returns { ok: false } so the caller keeps the last good config.
// The app never crashes on config.

import { parse as parseToml, TomlError } from "smol-toml";
import { PRESETS } from "../domain.ts";
import {
  isSettingKey,
  type PartialSettings,
  type SettingKey,
  validateSetting,
  viewShape,
} from "../settings/schema.ts";
import { indexLines, joinPath, lineOf } from "./lines.ts";

/** The config file format version this parser understands. */
export const CONFIG_SCHEMA_VERSION = 1;

export interface ConfigWarning {
  /** One-based line, or null when the line could not be located. */
  line: number | null;
  /** The dotted key the warning is about, as written in the file. */
  key: string;
  message: string;
}

export interface ConfigError {
  line: number | null;
  column: number | null;
  message: string;
}

export type ParseConfigResult =
  | {
      ok: true;
      /** Validated values, keyed by Setting key. */
      values: PartialSettings;
      warnings: ConfigWarning[];
      /** The `schema` the file declared, or 1 when absent. */
      schema: number;
    }
  | { ok: false; error: ConfigError };

/**
 * Older or friendlier spellings the file may use, mapped onto schema keys.
 * The mock in design/ uses these; they apply silently.
 */
export const KEY_ALIASES: Readonly<Record<string, SettingKey>> = {
  "appearance.theme": "appearance.mode",
  "layout.sections": "sections.order",
  "ai.api.provider": "ai.hosted.provider",
};

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function parseConfig(text: string): ParseConfigResult {
  let doc: Table;
  try {
    doc = parseToml(text) as Table;
  } catch (err) {
    if (err instanceof TomlError) {
      return { ok: false, error: { line: err.line, column: err.column, message: err.message } };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { line: null, column: null, message } };
  }

  const index = indexLines(text);
  const warnings: ConfigWarning[] = [];
  const values: Record<string, unknown> = {};
  const warn = (path: string[], message: string) =>
    warnings.push({ line: lineOf(index, path), key: joinPath(path), message });

  let schema = CONFIG_SCHEMA_VERSION;
  if ("schema" in doc) {
    const declared = doc.schema;
    if (typeof declared === "number" && Number.isInteger(declared) && declared >= 1) {
      schema = declared;
      if (declared > CONFIG_SCHEMA_VERSION) {
        warn(
          ["schema"],
          `Config schema ${declared} is newer than this app understands (${CONFIG_SCHEMA_VERSION}). Keys it does not know are ignored.`,
        );
      }
    } else {
      warn(["schema"], `schema must be a whole number of 1 or more, got ${describe(declared)}`);
    }
  }

  const views: unknown[] = [];

  const apply = (path: string[], value: unknown) => {
    const key = KEY_ALIASES[joinPath(path)] ?? joinPath(path);
    const result = validateSetting(key, value);
    if (result.ok) values[key] = result.value;
    else warn(path, result.error);
  };

  const walk = (path: string[], value: unknown) => {
    const dotted = joinPath(path);
    if (path.length === 1 && dotted === "schema") return;
    if (isSettingKey(dotted) || dotted in KEY_ALIASES) {
      apply(path, value);
      return;
    }
    // A [views.<name>] table is one View whose id is the name.
    if (path.length === 2 && path[0] === "views" && isTable(value)) {
      const view = viewFromTable(path[1] as string, value, path, warn);
      if (view) views.push(view);
      return;
    }
    if (isTable(value)) {
      for (const [child, childValue] of Object.entries(value)) walk([...path, child], childValue);
      return;
    }
    warn(path, `Unknown key "${dotted}"`);
  };

  for (const [top, value] of Object.entries(doc)) walk([top], value);

  if (views.length > 0) {
    const existing = Array.isArray(values["views.list"]) ? (values["views.list"] as unknown[]) : [];
    const result = validateSetting("views.list", [...existing, ...views]);
    if (result.ok) values["views.list"] = result.value;
  }

  return { ok: true, values: values as PartialSettings, warnings, schema };
}

const VIEW_KNOBS = ["nav", "agent", "list"] as const;

function viewFromTable(
  name: string,
  table: Table,
  path: string[],
  warn: (path: string[], message: string) => void,
): unknown {
  const layout: Record<string, unknown> = { ...PRESETS.stream };
  const preset = table.preset;
  if (typeof preset === "string" && preset in PRESETS) {
    Object.assign(layout, PRESETS[preset as keyof typeof PRESETS]);
  } else if (preset !== undefined) {
    warn([...path, "preset"], `Unknown preset ${describe(preset)}`);
  }
  for (const knob of VIEW_KNOBS) {
    if (table[knob] !== undefined) layout[knob] = table[knob];
  }
  for (const key of Object.keys(table)) {
    if (key === "preset" || key === "shortcut" || key === "name") continue;
    if (!(VIEW_KNOBS as readonly string[]).includes(key)) {
      warn([...path, key], `Unknown key "${joinPath([...path, key])}"`);
    }
  }
  const candidate = {
    id: name,
    name: typeof table.name === "string" ? table.name : name,
    shortcut: typeof table.shortcut === "string" ? table.shortcut : null,
    layout,
  };
  const result = viewShape.safeParse(candidate);
  if (result.success) return result.data;
  warn(
    path,
    result.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; "),
  );
  return null;
}

function describe(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (Array.isArray(value)) return "an array";
  if (isTable(value)) return "a table";
  return String(value);
}
