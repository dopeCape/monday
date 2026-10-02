/// <reference types="bun-types" />
// The pinned fetch's webview side: a request crosses to the native command as
// JSON with a base64 body, the answer comes back as a Response, and a wrong
// certificate rejects with an Error named "PinMismatch".

import { describe, expect, test } from "bun:test";
import { type InvokeLike, type PinnedRequest, pinnedFetchOver } from "./pinned.ts";

function scripted(answer: (r: PinnedRequest) => unknown) {
  const seen: Array<{ command: string; request: PinnedRequest }> = [];
  const invoke = (async (command: string, args: Record<string, unknown>) => {
    const request = args.request as PinnedRequest;
    seen.push({ command, request });
    return answer(request);
  }) as InvokeLike;
  return { invoke, seen };
}

describe("pinnedFetchOver", () => {
  test("sends the method, headers and body, and reads the answer as a Response", async () => {
    const { invoke, seen } = scripted(() => ({
      status: 201,
      statusText: "Created",
      headers: [["content-type", "application/json"]],
      body: btoa(JSON.stringify({ token: "t" })),
    }));
    const res = await pinnedFetchOver(invoke)("FP")("https://192.168.1.20:47820/pair/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer x" },
      body: JSON.stringify({ code: "ABCD1234" }),
    });
    expect(seen[0]?.command).toBe("pinned_fetch");
    const r = seen[0]?.request;
    expect(r?.fingerprint).toBe("FP");
    expect(r?.method).toBe("POST");
    expect(r?.url).toBe("https://192.168.1.20:47820/pair/redeem");
    expect(new Map(r?.headers).get("authorization")).toBe("Bearer x");
    expect(atob(r?.body ?? "")).toBe(JSON.stringify({ code: "ABCD1234" }));
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ token: "t" });
  });

  test("a GET carries no body, and a 204 answers with none", async () => {
    const { invoke, seen } = scripted(() => ({
      status: 204,
      statusText: "No Content",
      headers: [],
      body: "",
    }));
    const res = await pinnedFetchOver(invoke)("FP")("https://10.0.0.2/health");
    expect(seen[0]?.request.body).toBeUndefined();
    expect(seen[0]?.request.method).toBe("GET");
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  test("a certificate that is not the pinned one rejects as PinMismatch, anything else as a TypeError", async () => {
    const mismatch = pinnedFetchOver((async () => {
      throw "PinMismatch: the certificate is not the one this phone pinned";
    }) as InvokeLike);
    const error = await mismatch("FP")("https://10.0.0.2/health").catch((e: Error) => e);
    expect((error as Error).name).toBe("PinMismatch");
    const down = pinnedFetchOver((async () => {
      throw "error sending request: connection refused";
    }) as InvokeLike);
    const other = await down("FP")("https://10.0.0.2/health").catch((e: Error) => e);
    expect(other).toBeInstanceOf(TypeError);
  });
});
