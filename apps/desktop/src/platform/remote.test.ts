import { describe, expect, test } from "bun:test";
import { encodePairingPayload } from "@monday/shared";
import type { FetchLike } from "./cloud.ts";
import {
  ConnectError,
  connectPhone,
  fetchFor,
  loadRemoteTarget,
  probeRemote,
  REMOTE_SECRET_KEY,
  type RemoteTarget,
  remoteState,
  saveRemoteTarget,
} from "./remote.ts";

interface Call {
  url: string;
  body: Record<string, unknown> | null;
  via: string;
}

/** A scripted Server: answers by URL; records which fetch carried each call. */
function script(answer: (url: string, body: Record<string, unknown> | null) => Response | Error): {
  calls: Call[];
  fetch: FetchLike;
  pinnedFetch: (fp: string) => FetchLike;
} {
  const calls: Call[] = [];
  const make =
    (via: string): FetchLike =>
    async (input, init) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, body, via });
      const out = answer(url, body);
      if (out instanceof Error) throw out;
      return out;
    };
  return { calls, fetch: make("plain"), pinnedFetch: (fp) => make(`pinned:${fp}`) };
}

const redeemed = (name = "tejas-laptop") =>
  Response.json({ deviceId: "dev-1", token: "tok-1", name }, { status: 201 });

const scanned = encodePairingPayload({
  name: "tejas-laptop",
  urls: ["https://192.168.1.20:47820", "https://mail.example.com"],
  secret: "the-secret",
  code: "AB12CD34",
  expiresAt: "2026-10-02T12:10:00Z",
  fingerprint: "q83vEjRWeJA",
});

describe("connecting a phone", () => {
  test("a scanned code redeems its secret over the pinned fetch at the first LAN address", async () => {
    const s = script(() => redeemed());
    const target = await connectPhone(
      { kind: "scan", text: scanned },
      { name: "Pixel 9", fetch: s.fetch, pinnedFetch: s.pinnedFetch },
    );
    expect(target).toEqual({
      baseUrl: "https://192.168.1.20:47820",
      token: "tok-1",
      deviceId: "dev-1",
      name: "tejas-laptop",
      fingerprint: "q83vEjRWeJA",
    });
    expect(s.calls).toEqual([
      {
        url: "https://192.168.1.20:47820/pair/redeem",
        body: { secret: "the-secret", name: "Pixel 9", kind: "phone" },
        via: "pinned:q83vEjRWeJA",
      },
    ]);
  });

  test("an address that does not answer falls through to the next; a public one is not pinned", async () => {
    const s = script((url) =>
      url.startsWith("https://192.168") ? new TypeError("Load failed") : redeemed(),
    );
    const target = await connectPhone(
      { kind: "scan", text: scanned },
      { name: "Pixel 9", fetch: s.fetch, pinnedFetch: s.pinnedFetch },
    );
    expect(target.baseUrl).toBe("https://mail.example.com");
    expect(s.calls.map((c) => c.via)).toEqual(["pinned:q83vEjRWeJA", "plain"]);
  });

  test("a certificate that is not the pinned one stops pairing", async () => {
    const mismatch = Object.assign(new Error("pin"), { name: "PinMismatch" });
    const s = script(() => mismatch);
    await expect(
      connectPhone({ kind: "scan", text: scanned }, { name: "P", ...s }),
    ).rejects.toMatchObject({ code: "pin" });
    expect(s.calls.length).toBe(1);
  });

  test("the emulator's manually typed address and short code, over plain http", async () => {
    const s = script(() => redeemed());
    const target = await connectPhone(
      { kind: "manual", url: "http://10.0.2.2:41234/", code: "ab12-cd34" },
      { name: "Emulator", fetch: s.fetch, pinnedFetch: s.pinnedFetch },
    );
    expect(target).toMatchObject({ baseUrl: "http://10.0.2.2:41234", fingerprint: null });
    expect(s.calls).toEqual([
      {
        url: "http://10.0.2.2:41234/pair/redeem",
        body: { code: "AB12CD34", name: "Emulator", kind: "phone" },
        via: "plain",
      },
    ]);
  });

  test("what cannot work is refused before any request", async () => {
    const s = script(() => redeemed());
    const cases: [Parameters<typeof connectPhone>[0], string][] = [
      [{ kind: "scan", text: "https://example.com" }, "not_a_code"],
      [{ kind: "manual", url: "http://mail.example.com", code: "AB12CD34" }, "insecure"],
      [{ kind: "manual", url: "ftp://x", code: "AB12CD34" }, "invalid_url"],
      [{ kind: "manual", url: "http://10.0.2.2:1", code: "short" }, "invalid_code"],
    ];
    for (const [input, code] of cases) {
      const error = await connectPhone(input, { name: "P", fetch: s.fetch }).catch((e) => e);
      expect(error).toBeInstanceOf(ConnectError);
      expect((error as ConnectError).code).toBe(code as ConnectError["code"]);
    }
    expect(s.calls).toEqual([]);
  });

  test("the Server's refusals: used or expired, too many tries, and nobody home", async () => {
    for (const [status, code] of [
      [409, "rejected"],
      [410, "rejected"],
      [404, "rejected"],
      [429, "too_many"],
    ] as const) {
      const s = script(() => Response.json({}, { status }));
      await expect(
        connectPhone(
          { kind: "manual", url: "http://10.0.2.2:1", code: "AB12CD34" },
          { name: "P", ...s },
        ),
      ).rejects.toMatchObject({ code });
    }
    const down = script(() => new TypeError("Load failed"));
    await expect(
      connectPhone({ kind: "scan", text: scanned }, { name: "P", ...down }),
    ).rejects.toMatchObject({ code: "unreachable" });
    expect(down.calls.length).toBe(2);
  });
});

describe("the phone's Server", () => {
  const target: RemoteTarget = {
    baseUrl: "https://192.168.1.20:47820",
    token: "tok-1",
    deviceId: "dev-1",
    name: "tejas-laptop",
    fingerprint: "q83vEjRWeJA",
  };

  test("is kept in the platform's secret store", async () => {
    const store = new Map<string, string>();
    const platform = {
      secretGet: async (k: string) => store.get(k) ?? null,
      secretSet: async (k: string, v: string) => void store.set(k, v),
      secretDelete: async (k: string) => void store.delete(k),
    };
    expect(await loadRemoteTarget(platform)).toBeNull();
    await saveRemoteTarget(platform, target);
    expect(store.has(REMOTE_SECRET_KEY)).toBe(true);
    expect(await loadRemoteTarget(platform)).toEqual(target);
    store.set(REMOTE_SECRET_KEY, "{not json");
    expect(await loadRemoteTarget(platform)).toBeNull();
    await saveRemoteTarget(platform, null);
    expect(store.has(REMOTE_SECRET_KEY)).toBe(false);
  });

  test("pins only https on a private network", () => {
    const s = script(() => new Response());
    expect(fetchFor(target.baseUrl, "fp", s)).not.toBe(s.fetch);
    expect(fetchFor("https://mail.example.com", "fp", s)).toBe(s.fetch);
    expect(fetchFor("http://10.0.2.2:1", "fp", s)).toBe(s.fetch);
    expect(fetchFor(target.baseUrl, null, s)).toBe(s.fetch);
  });

  test("its status: connected, locked, revoked, unreachable", async () => {
    const answer = (me: number, unlocked: boolean) =>
      script((url) =>
        url.endsWith("/devices/me")
          ? Response.json({}, { status: me })
          : Response.json({ unlocked }),
      );
    expect(await probeRemote(target, answer(200, true))).toBe("connected");
    expect(await probeRemote(target, answer(200, false))).toBe("locked");
    expect(await probeRemote(target, answer(401, true))).toBe("revoked");
    expect(
      await probeRemote(
        target,
        script(() => new TypeError("down")),
      ),
    ).toBe("unreachable");
    const s = answer(200, true);
    await probeRemote(target, s);
    expect(s.calls.every((c) => c.via === "pinned:q83vEjRWeJA")).toBe(true);
    expect(remoteState({ answered: null })).toBe("connecting");
  });
});
