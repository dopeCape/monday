// Templates and conditions: the one mechanism a Step uses to read what came
// before it. A text holds {{thread.subject}}, {{thread.from}}, {{thread.id}},
// {{run.id}} and {{steps.<id>.<field>}} holes; a condition tests a rendered
// template. Nothing here reaches a model.

/** What an earlier Step reported, keyed by the field names the Step declared. */
export type StepContext = Record<string, unknown>;

export interface TemplateContext {
  thread: {
    id: string;
    subject: string;
    from: string;
    fromEmail?: string | undefined;
    group?: string | null | undefined;
    tags?: readonly string[] | undefined;
  } | null;
  run: { id: string; workflow: string };
  steps: Record<string, StepContext>;
}

/** Reads a dotted path off the context; missing parts read as undefined. */
export function readPath(ctx: TemplateContext, path: string): unknown {
  let current: unknown = ctx;
  for (const part of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringOf).join(", ");
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Fills every {{path}} hole; an unknown path renders empty. */
export function renderTemplate(text: string, ctx: TemplateContext): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, path: string) =>
    stringOf(readPath(ctx, path)),
  );
}

export function evaluateCondition(
  when: {
    left: string;
    op: "contains" | "equals" | "matches" | "exists" | "not_contains" | "judged";
    value?: string | undefined;
  },
  ctx: TemplateContext,
): boolean {
  const left = renderTemplate(when.left, ctx).trim();
  const value = (when.value ?? "").trim();
  switch (when.op) {
    // A judged condition needs the judge (the Server asks it first); without one it is false.
    case "judged":
      return false;
    case "exists":
      return left.length > 0;
    case "equals":
      return left.toLowerCase() === value.toLowerCase();
    case "contains":
      return value.length > 0 && left.toLowerCase().includes(value.toLowerCase());
    case "not_contains":
      return !(value.length > 0 && left.toLowerCase().includes(value.toLowerCase()));
    case "matches": {
      try {
        return new RegExp(value, "i").test(left);
      } catch {
        return false;
      }
    }
  }
}
