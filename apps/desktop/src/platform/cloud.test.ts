// The second target (ADR 0005, ADR 0008) through its interface: the picker
// prefers the Cloud when it answers and falls back to the Sidecar, the
// pairing flow takes the setup code or a code another Device confirms, and
// the Cloud target round trips through the keychain. The server is a
// scripted fetch.

import { describe, expect, test } from "bun:test";
import type { ServerTarget } from "./api.ts";
import {
  createTargetPicker,
  type FetchLike,
  loadCloudTarget,
  normalizeCloudUrl,
  PairError,
  pairCloud,
  saveCloudTarget,
} from "./cloud.ts";
import { fakePlatform } from "./tauri.ts";

const SIDECAR: ServerTarget = { baseUrl: "http://127.0.0.1:4242", token: "launch" };
const CLOUD: ServerTarget = { baseUrl: "https://monday.example", token: "device" };

describe("normalizeCloudUrl", () => {
  test("adds https, drops trailing slashes, refuses junk", () => {
    expect(normalizeCloudUrl("monday.example")).toBe("https://monday.example");
    expect(normalizeCloudUrl(" https://monday.example/ ")).toBe("https://monday.example");
    expect(normalizeCloudUrl("https://x.example/monday/")).toBe("https://x.example/monday");
    expect(normalizeCloudUrl("http://10.0.0.5:8787")).toBe("http://10.0.0.5:8787");
    expect(normalizeCloudUrl("ftp://x")).toBeNull();
    expect(normalizeCloudUrl("")).toBeNull();
    expect(normalizeCloudUrl("not a url at all")).toBeNull();
  });
});

describe("target picker", () => {
  const picker = (
    targets: { sidecar: ServerTarget | null; cloud: ServerTarget | null },
    up: Set<string>,
    prefer: "cloud" | "sidecar" = "cloud",
  ) =>
    createTargetPicker({
      targets: () => targets,
      prefer: () => prefer,
      probe: async (t) => up.has(t.baseUrl),
    });

  test("the preferred target wins while it is reachable", async () => {
    const p = picker({ sidecar: SIDECAR, cloud: CLOUD }, new Set([SIDECAR.baseUrl, CLOUD.baseUrl]));
    expect(p.current()?.kind).toBe("cloud");
    await p.refresh();
    expect(p.current()?.kind).toBe("cloud");
    const s = picker({ sidecar: SIDECAR, cloud: CLOUD }, new Set([SIDECAR.baseUrl]), "sidecar");
    expect(s.current()?.kind).toBe("sidecar");
  });

  test("a failed request moves to the other target until a probe brings it back", async () => {
    const up = new Set([SIDECAR.baseUrl]);
    const p = picker({ sidecar: SIDECAR, cloud: CLOUD }, up);
    const seen: string[] = [];
    p.subscribe((picked) => seen.push(picked?.kind ?? "none"));
    expect(p.current()?.kind).toBe("cloud"); // nothing known yet: trust the preference
    p.markUnreachable(CLOUD);
    expect(p.current()?.kind).toBe("sidecar");
    expect(seen).toEqual(["sidecar"]);
    await p.refresh();
    expect(p.current()?.kind).toBe("sidecar");
    up.add(CLOUD.baseUrl);
    await p.refresh();
    expect(p.current()?.kind).toBe("cloud");
    expect(seen).toEqual(["sidecar", "cloud"]);
  });

  test("with one target it is used even when unreachable; with none there is nothing", async () => {
    const p = picker({ sidecar: SIDECAR, cloud: null }, new Set());
    await p.refresh();
    expect(p.current()).toEqual({ kind: "sidecar", target: SIDECAR });
    const laptopClosed = picker({ sidecar: null, cloud: CLOUD }, new Set([CLOUD.baseUrl]));
    expect(laptopClosed.current()?.kind).toBe("cloud");
    expect(picker({ sidecar: null, cloud: null }, new Set()).current()).toBeNull();
  });
});

describe("pairing with the Cloud", () => {
  interface Call {
    path: string;
    body: Record<string, unknown>;
  }
  /** A scripted Cloud: answers per path, records every call. */
  function cloud(script: Record<string, Array<{ status: number; body?: unknown }>>) {
    const calls: Call[] = [];
    const remaining = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
    const fetchFn: FetchLike = async (input, init) => {
      const url = String(input);
      const path = new URL(url).pathname;
      calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const queue = remaining[path] ?? [];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (!next) throw new TypeError("connection refused");
      return new Response(JSON.stringify(next.body ?? {}), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    };
    return { calls, fetch: fetchFn };
  }

  test("a fresh Cloud takes the setup code and mints the token", async () => {
    const c = cloud({ "/pair/setup": [{ status: 201, body: { deviceId: "d1", token: "tok" } }] });
    const out = await pairCloud("https://monday.example", " 424242 ", {
      name: "Laptop",
      fetch: c.fetch,
    });
    expect(out).toEqual({
      status: "paired",
      target: { baseUrl: "https://monday.example", token: "tok", deviceId: "d1" },
    });
    expect(c.calls).toEqual([
      { path: "/pair/setup", body: { setupCode: "424242", name: "Laptop" } },
    ]);
  });

  test("a wrong setup code and an unreachable Cloud are typed errors", async () => {
    const wrong = cloud({
      "/pair/setup": [{ status: 403, body: { error: "invalid_setup_code" } }],
    });
    await expect(
      pairCloud("https://monday.example", "1", { name: "L", fetch: wrong.fetch }),
    ).rejects.toMatchObject({ code: "invalid_setup_code" });
    const down = cloud({});
    await expect(
      pairCloud("https://monday.example", "1", { name: "L", fetch: down.fetch }),
    ).rejects.toMatchObject({ code: "unreachable" });
  });

  test("a Cloud with Devices hands out a code another Device confirms, then the claim pairs", async () => {
    const c = cloud({
      "/pair/setup": [{ status: 409, body: { error: "setup_already_done" } }],
      "/pair/start": [
        { status: 201, body: { code: "654321", secret: "s3", expiresAt: "2026-09-17T10:00:00Z" } },
      ],
      "/pair/claim": [
        { status: 202, body: { status: "pending" } },
        { status: 202, body: { status: "pending" } },
        { status: 200, body: { status: "paired", deviceId: "d2", token: "tok2" } },
      ],
    });
    const out = await pairCloud("https://monday.example", "424242", {
      name: "Laptop",
      fetch: c.fetch,
      pollMs: 0,
      sleep: async () => {},
    });
    if (out.status !== "confirm") throw new Error("expected confirm");
    expect(out.code).toBe("654321");
    const target = await out.claim();
    expect(target).toEqual({ baseUrl: "https://monday.example", token: "tok2", deviceId: "d2" });
    expect(c.calls.filter((x) => x.path === "/pair/claim")).toHaveLength(3);
    expect(c.calls.at(-1)?.body).toEqual({ secret: "s3" });
  });

  test("an expired code fails the claim", async () => {
    const c = cloud({
      "/pair/setup": [{ status: 409 }],
      "/pair/start": [{ status: 201, body: { code: "1", secret: "s", expiresAt: "x" } }],
      "/pair/claim": [{ status: 410, body: { error: "expired" } }],
    });
    const out = await pairCloud("https://monday.example", "1", { name: "L", fetch: c.fetch });
    if (out.status !== "confirm") throw new Error("expected confirm");
    await expect(out.claim()).rejects.toBeInstanceOf(PairError);
  });

  test("plain http is refused unless the Setting allows it", async () => {
    const c = cloud({ "/pair/setup": [{ status: 201, body: { deviceId: "d", token: "t" } }] });
    await expect(
      pairCloud("http://10.0.0.5:8787", "1", { name: "L", fetch: c.fetch }),
    ).rejects.toMatchObject({ code: "insecure" });
    expect(c.calls).toHaveLength(0);
    const ok = await pairCloud("http://10.0.0.5:8787", "1", {
      name: "L",
      fetch: c.fetch,
      insecureAllowed: true,
    });
    expect(ok.status).toBe("paired");
  });
});

describe("the Cloud target in the keychain", () => {
  test("round trips, forgets, and ignores a corrupt entry", async () => {
    const p = fakePlatform();
    expect(await loadCloudTarget(p)).toBeNull();
    const target = { baseUrl: "https://monday.example", token: "t", deviceId: "d" };
    await saveCloudTarget(p, target);
    expect(await loadCloudTarget(p)).toEqual(target);
    await p.secretSet("server.cloud", "{not json");
    expect(await loadCloudTarget(p)).toBeNull();
    await saveCloudTarget(p, target);
    await saveCloudTarget(p, null);
    expect(await loadCloudTarget(p)).toBeNull();
  });
});
