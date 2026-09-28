// The Server's copy of the MCP Registry (src/workflows/mcp-catalog.ts): while
// it is empty a search asks the registry live; a pass fills it page by page
// and a stopped pass resumes at its cursor; a search then answers from
// Postgres with exact names first and demoted namespaces last; a stale copy
// refreshes with `updated_since`; another registry URL starts over.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mcpCatalog, mcpCatalogSync } from "../src/db/schema.ts";
import { createMcpCatalog, type McpCatalogSettings } from "../src/workflows/mcp-catalog.ts";
import { createMcpRegistry } from "../src/workflows/mcp-registry.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

setDefaultTimeout(30_000);

const REGISTRY = "https://registry.test/v0.1";

const server = (name: string, title: string, description: string, remote = true) => ({
  server: {
    name,
    title,
    description,
    version: "1.0.0",
    ...(remote
      ? {
          remotes: [
            { type: "streamable-http", url: `https://${name.replace(/\W+/g, "-")}.test/mcp` },
          ],
        }
      : {
          packages: [
            {
              registryType: "npm",
              identifier: `@x/${name.split("/")[1]}`,
              version: "1.0.0",
              transport: { type: "stdio" },
            },
          ],
        }),
  },
});

/** 250 filler servers plus the ones the ranking tests look for. */
function fixtureServers() {
  const out = [
    server("ai.smithery/someone-slack", "Slack (hosted)", "Slack through Smithery."),
    server("com.slack/slack", "Slack", "Messages and channels in Slack."),
    server("io.github.fan/slack-tools", "Slack tools", "Extra Slack helpers.", false),
    server("io.github.x/notion", "Notion", "Pages and databases."),
  ];
  for (let i = 0; i < 250; i++)
    out.push(server(`io.github.filler/tool-${i}`, `Tool ${i}`, "Filler."));
  return out;
}

interface FakeRegistry {
  calls: string[];
  servers: ReturnType<typeof server>[];
  /** A page request number that fails once, 1-based. */
  failPage: number | null;
  fetch: (url: string) => Promise<Response>;
}

function fakeRegistry(): FakeRegistry {
  const reg: FakeRegistry = {
    calls: [],
    servers: fixtureServers(),
    failPage: null,
    fetch: async (url) => {
      reg.calls.push(url);
      const u = new URL(url);
      if (u.pathname !== "/v0.1/servers") return new Response("not found", { status: 404 });
      const search = (u.searchParams.get("search") ?? "").toLowerCase();
      if (search) {
        const found = reg.servers.filter((s) => s.server.name.includes(search)).slice(0, 5);
        return Response.json({ servers: found, metadata: { count: found.length } });
      }
      const pageNo = reg.calls.filter((c) => !new URL(c).searchParams.get("search")).length;
      if (reg.failPage === pageNo) {
        reg.failPage = null;
        return new Response("busy", { status: 503 });
      }
      const since = u.searchParams.get("updated_since");
      const pool = since ? reg.servers.filter((s) => s.server.version === "2.0.0") : reg.servers;
      const limit = Number(u.searchParams.get("limit") ?? "100");
      const start = Number(u.searchParams.get("cursor") ?? "0");
      const page = pool.slice(start, start + limit);
      const next = start + limit < pool.length ? String(start + limit) : null;
      return Response.json({ servers: page, metadata: { count: page.length, nextCursor: next } });
    },
  };
  return reg;
}

let db: TestDatabase;
beforeAll(async () => {
  db = await testDatabase();
});
afterAll(async () => {
  await db.drop();
});

const reset = async () => {
  await db.handle.db.delete(mcpCatalog);
  await db.handle.db.delete(mcpCatalogSync);
};

function catalogOver(
  reg: FakeRegistry,
  overrides: Partial<McpCatalogSettings> = {},
  clock = { t: Date.parse("2026-09-28T10:00:00Z") },
) {
  const settings: McpCatalogSettings = {
    enabled: true,
    url: REGISTRY,
    results: 10,
    refreshHours: 24,
    demote: ["ai.smithery/"],
    liveWaitMs: 2000,
    ...overrides,
  };
  const live = createMcpRegistry({
    settings: async () => ({ enabled: true, url: settings.url, results: 10, cacheMinutes: 0 }),
    fetch: reg.fetch,
  });
  const catalog = createMcpCatalog({
    db: db.handle.db,
    live,
    settings: async () => settings,
    fetch: reg.fetch,
    now: () => clock.t,
    pageSize: 100,
  });
  return { catalog, settings, clock };
}

const searchCalls = (reg: FakeRegistry) =>
  reg.calls.filter((c) => new URL(c).searchParams.get("search")).length;

describe("the Server's copy of the MCP Registry", () => {
  test("empty, a search asks the registry live and starts the fill; filled, it answers from the copy", async () => {
    await reset();
    const reg = fakeRegistry();
    // The first page of the fill fails, so the copy is still empty when the search looks.
    reg.failPage = 1;
    const { catalog } = catalogOver(reg);
    const first = await catalog.search("notion");
    expect(first.map((e) => e.id)).toEqual(["io.github.x/notion"]);
    expect(searchCalls(reg)).toBe(1);
    // The failed pass is over; the next one fills the copy.
    await catalog.syncOnce();
    await catalog.syncOnce();
    const status = await catalog.status();
    expect(status).toMatchObject({ count: 254, complete: true, lastError: null });
    const again = await catalog.search("notion");
    expect(again.map((e) => e.id)).toEqual(["io.github.x/notion"]);
    // No second live search: the copy answered.
    expect(searchCalls(reg)).toBe(1);
  });

  test("the exact name first, remote before local, demoted namespaces last; every word must match", async () => {
    await reset();
    const reg = fakeRegistry();
    const { catalog } = catalogOver(reg);
    await catalog.syncOnce();
    expect((await catalog.search("slack")).map((e) => e.id)).toEqual([
      "com.slack/slack",
      "io.github.fan/slack-tools",
      "ai.smithery/someone-slack",
    ]);
    expect((await catalog.search("slack helpers")).map((e) => e.id)).toEqual([
      "io.github.fan/slack-tools",
    ]);
    expect(await catalog.search("nothing-like-this")).toEqual([]);
    // A LIKE wildcard in the query is taken literally.
    expect(await catalog.search("%")).toEqual([]);
  });

  test("a pass that fails part way keeps its cursor, and the next one resumes there", async () => {
    await reset();
    const reg = fakeRegistry();
    reg.failPage = 2;
    const { catalog } = catalogOver(reg);
    await catalog.syncOnce();
    const stopped = await catalog.status();
    expect(stopped.complete).toBe(false);
    expect(stopped.count).toBe(100);
    expect(stopped.lastError).toContain("503");
    await catalog.syncOnce();
    const pages = reg.calls.filter((c) => !new URL(c).searchParams.get("search"));
    // The resumed pass starts at the stopped cursor, not at the first page again.
    expect(new URL(pages[2] as string).searchParams.get("cursor")).toBe("100");
    expect(await catalog.status()).toMatchObject({ count: 254, complete: true, lastError: null });
  });

  test("an old copy refreshes with updated_since and picks up changed servers", async () => {
    await reset();
    const reg = fakeRegistry();
    const { catalog, clock } = catalogOver(reg);
    await catalog.syncOnce();
    const notion = reg.servers.find((s) => s.server.name === "io.github.x/notion");
    if (!notion) throw new Error("fixture");
    notion.server.version = "2.0.0";
    notion.server.description = "Pages, databases and comments.";
    // Fresh: a search does not start a pass.
    const before = reg.calls.length;
    await catalog.search("notion");
    expect(reg.calls.length).toBe(before);
    clock.t += 25 * 3_600_000;
    await catalog.search("notion");
    await catalog.syncOnce();
    const refresh = reg.calls.slice(before).map((c) => new URL(c));
    expect(
      refresh.some((u) => u.searchParams.get("updated_since") === "2026-09-28T10:00:00.000Z"),
    ).toBe(true);
    expect((await catalog.search("comments")).map((e) => e.id)).toEqual(["io.github.x/notion"]);
  });

  test("a live search the registry is slow to answer never holds a search up past the wait", async () => {
    await reset();
    const reg = fakeRegistry();
    reg.failPage = 1;
    const slow: FakeRegistry = {
      ...reg,
      fetch: async (url) => {
        if (new URL(url).searchParams.get("search")) await new Promise((r) => setTimeout(r, 5_000));
        return reg.fetch(url);
      },
    };
    const { catalog } = catalogOver(slow, { liveWaitMs: 200 });
    const started = Date.now();
    expect(await catalog.search("notion")).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
    await catalog.syncOnce();
  });

  test("another registry URL starts the copy over", async () => {
    await reset();
    const reg = fakeRegistry();
    const { catalog, settings } = catalogOver(reg);
    await catalog.syncOnce();
    settings.url = "https://other-registry.test/v0.1";
    const other = fakeRegistry();
    other.servers = [server("io.github.y/only-here", "Only here", "One server.")];
    const moved = createMcpCatalog({
      db: db.handle.db,
      live: createMcpRegistry({
        settings: async () => ({ enabled: true, url: settings.url, results: 10, cacheMinutes: 0 }),
        fetch: other.fetch,
      }),
      settings: async () => settings,
      fetch: other.fetch,
    });
    await moved.syncOnce();
    expect(await moved.status()).toMatchObject({ count: 1, complete: true });
    expect((await moved.search("")).map((e) => e.id)).toEqual(["io.github.y/only-here"]);
    void catalog;
  });
});
