// The Cloud entries booted against a real database: the Vercel handler in
// the Web signature, the Netlify handler with its context, and the Netlify
// scheduled tick. Each answers /health, reports its mode from /capabilities,
// and the cron tick refuses a caller without the secret.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Capabilities } from "@monday/shared";
import { type TestDatabase, testDatabase } from "./harness.ts";

describe("cloud entries", () => {
  let db: TestDatabase;
  const saved: Record<string, string | undefined> = {};
  const keys = [
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "MONDAY_MODE",
    "MONDAY_SETUP_CODE",
    "CRON_SECRET",
    "MONDAY_SERVER_ID",
  ];

  beforeAll(async () => {
    db = await testDatabase();
    for (const k of keys) saved[k] = process.env[k];
    process.env.DATABASE_URL = db.url;
    process.env.DATABASE_URL_UNPOOLED = db.url;
    process.env.MONDAY_SETUP_CODE = "111222";
    process.env.CRON_SECRET = "cron-secret";
    process.env.MONDAY_SERVER_ID = "entry-test";
  }, 60_000);

  afterAll(async () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    const vercel = await import("../entry/vercel.ts");
    await (await vercel.boot()).close();
    const netlify = await import("../entry/netlify.ts");
    await (await netlify.boot()).close();
    await db.drop();
  });

  test("the Vercel handler serves the app and the cron tick behind CRON_SECRET", async () => {
    const { default: handler } = await import("../entry/vercel.ts");
    const health = await handler(new Request("https://monday.vercel.app/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, mode: "vercel" });

    const caps = (await (
      await handler(new Request("https://monday.vercel.app/capabilities"))
    ).json()) as Capabilities;
    expect(caps.mode).toBe("vercel");
    expect(caps.realtime).toBe("sse");
    expect(caps.features.scheduledSendsWhileClosed).toBe(true);
    expect(caps.features.holdsConnections).toBe(false);

    const refused = await handler(new Request("https://monday.vercel.app/cron/tick"));
    expect(refused.status).toBe(401);
    const ticked = await handler(
      new Request("https://monday.vercel.app/cron/tick", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(ticked.status).toBe(200);
    expect(await ticked.json()).toMatchObject({ ran: 0, swept: 0 });

    // The tick left the Cloud's heartbeat, so the topology now reads cloud.
    const after = (await (
      await handler(new Request("https://monday.vercel.app/capabilities"))
    ).json()) as Capabilities;
    expect(after.topology).toBe("cloud");
    expect(after.servers.map((s) => s.id)).toEqual(["entry-test"]);
  }, 60_000);

  test("the Netlify handler and its scheduled tick", async () => {
    const netlify = await import("../entry/netlify.ts");
    const kept: Promise<unknown>[] = [];
    const context = { waitUntil: (p: Promise<unknown>) => void kept.push(p) };
    const health = await netlify.default(new Request("https://monday.netlify.app/health"), context);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, mode: "netlify" });

    // Nobody may tick over HTTP on Netlify; the scheduler calls the function.
    const refused = await netlify.default(
      new Request("https://monday.netlify.app/cron/tick", {
        headers: { authorization: "Bearer cron-secret" },
      }),
      context,
    );
    expect(refused.status).toBe(401);
    const { default: scheduled } = await import("../entry/netlify/tick.ts");
    const ticked = await scheduled();
    expect(ticked.status).toBe(200);
    expect(await ticked.json()).toMatchObject({ stopped: "empty" });
  }, 60_000);
});
