// The people index (src/people/index.ts) over HTTP. Headers only: works locked.
//   GET /people?workspace=&q=&limit=   {people: PersonHit[]}, best score first,
//                                      the Workspace's own address never among them

import type { PeopleSearchPage } from "@monday/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import type { Db } from "../db/client.ts";
import { ownerLookup, searchPeople } from "../people/index.ts";
import { readGlobalSettings } from "../settings/read.ts";

const peopleQuery = z.object({
  workspace: z.string().min(1),
  q: z.string().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(8),
});

export interface PeopleRouteOptions {
  now?: () => Date;
}

export function peopleRoutes(db: Db, options: PeopleRouteOptions = {}) {
  const app = new Hono<AppEnv>();
  const ownerOf = ownerLookup();

  app.get("/people", async (c) => {
    const parsed = peopleQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_query", issues: parsed.error.issues }, 400);
    }
    const q = parsed.data;
    const s = await readGlobalSettings(db, [
      "people.weights",
      "people.recency_half_life_days",
    ] as const);
    const people = await searchPeople(db, q.workspace, await ownerOf(db, q.workspace), {
      q: q.q,
      limit: q.limit,
      ranking: { weights: s["people.weights"], halfLifeDays: s["people.recency_half_life_days"] },
      ...(options.now ? { now: options.now() } : {}),
    });
    return c.json({ people } satisfies PeopleSearchPage);
  });

  return app;
}
