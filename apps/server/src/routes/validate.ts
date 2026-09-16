import type { Context } from "hono";
import type { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

/** Parses a JSON body against a zod schema; a bad body is a 400 with the issues. */
export async function parseBody<S extends z.ZodType>(
  c: Context<AppEnv>,
  schema: S,
): Promise<Parsed<z.output<S>>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: "invalid_json" }, 400) };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      response: c.json({ error: "invalid_body", issues: result.error.issues }, 400),
    };
  }
  return { ok: true, data: result.data };
}
