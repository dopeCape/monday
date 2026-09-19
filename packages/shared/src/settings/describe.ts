// What a Setting's zod type looks like to a renderer: the control shape the
// Settings screens (and any other client of the schema) pick a control from,
// with the enum options and number range read out of the type itself. One
// place reads zod's internals so the screens never do.

import type { z } from "zod";
import type { SettingKey } from "./schema.ts";
import { settingsSchema } from "./schema.ts";

export type ControlShape =
  | { kind: "boolean" }
  | { kind: "enum"; options: string[] }
  | { kind: "number"; integer: boolean; min: number | null; max: number | null }
  | { kind: "string"; url: boolean; maxLength: number | null }
  | { kind: "list"; item: ControlShape }
  | { kind: "record"; value: ControlShape }
  | { kind: "json" };

interface ZodInternals {
  _zod: {
    def: {
      type: string;
      format?: string;
      checks?: Array<{ _zod: { def: Record<string, unknown> } }>;
      element?: unknown;
      valueType?: unknown;
    };
  };
  options?: unknown[];
}

function internals(type: unknown): ZodInternals["_zod"]["def"] & { options?: unknown[] } {
  const t = type as ZodInternals;
  return { ...t._zod.def, ...(t.options ? { options: t.options } : {}) };
}

function checks(def: ReturnType<typeof internals>): Array<Record<string, unknown>> {
  return (def.checks ?? []).map((c) => c._zod.def);
}

/** The control shape of a zod type. Anything without a plain shape is edited as JSON. */
export function describeType(type: z.ZodType): ControlShape {
  const def = internals(type);
  switch (def.type) {
    case "boolean":
      return { kind: "boolean" };
    case "enum":
      return { kind: "enum", options: (def.options ?? []).map(String) };
    case "number": {
      let min: number | null = null;
      let max: number | null = null;
      for (const c of checks(def)) {
        if (c.check === "greater_than" && typeof c.value === "number") min = c.value;
        if (c.check === "less_than" && typeof c.value === "number") max = c.value;
      }
      return { kind: "number", integer: def.format === "safeint", min, max };
    }
    case "string": {
      let maxLength: number | null = null;
      for (const c of checks(def)) {
        if (c.check === "max_length" && typeof c.maximum === "number") maxLength = c.maximum;
      }
      return { kind: "string", url: def.format === "url", maxLength };
    }
    case "array":
      return { kind: "list", item: describeType(def.element as z.ZodType) };
    case "record":
      return { kind: "record", value: describeType(def.valueType as z.ZodType) };
    default:
      return { kind: "json" };
  }
}

/** The control shape of a Setting. */
export function describeSetting(key: SettingKey): ControlShape {
  return describeType(settingsSchema[key].type);
}
