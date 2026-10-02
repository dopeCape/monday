// The webview's side of the pinned fetch (src-tauri/src/pinned.rs): a fetch
// that sends each request through the native layer, which accepts only the
// certificate a phone pinned at pairing. A webview cannot pin a certificate
// itself. The request and the answer cross as JSON with base64 bodies; a
// certificate that is not the pinned one rejects with an Error named
// "PinMismatch" (platform/remote.ts tells the person so), any other failure
// with a TypeError, as fetch does.
//
// No Tauri import here: the caller hands in `invoke`, so tests script it.

import type { FetchLike } from "./cloud.ts";

/** What `pinned_fetch` takes. */
export interface PinnedRequest {
  fingerprint: string;
  url: string;
  method: string;
  headers: Array<[string, string]>;
  /** Base64; absent without a body. */
  body?: string;
}

/** What `pinned_fetch` answers. */
export interface PinnedResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  /** Base64. */
  body: string;
}

export type InvokeLike = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

/** Statuses whose Response may not carry a body. */
const NO_BODY = new Set([101, 103, 204, 205, 304]);

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

function fromBase64(b64: string): Uint8Array {
  const text = atob(b64);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** The Error the rest of the app knows a wrong certificate by. */
export function pinError(message: unknown): Error {
  const text = typeof message === "string" ? message : String(message);
  if (text.startsWith("PinMismatch")) {
    const e = new Error(text);
    e.name = "PinMismatch";
    return e;
  }
  return new TypeError(text);
}

/** A fetch pinned to `fingerprint`, over the `pinned_fetch` command. */
export function pinnedFetchOver(invoke: InvokeLike): (fingerprint: string) => FetchLike {
  return (fingerprint) => async (input, init) => {
    const req = new Request(input, init);
    const bytes = new Uint8Array(await req.arrayBuffer());
    const request: PinnedRequest = {
      fingerprint,
      url: req.url,
      method: req.method,
      headers: [...req.headers.entries()],
      ...(bytes.length > 0 ? { body: toBase64(bytes) } : {}),
    };
    let res: PinnedResponse;
    try {
      res = await invoke<PinnedResponse>("pinned_fetch", { request });
    } catch (error) {
      throw pinError(error);
    }
    const body = NO_BODY.has(res.status) ? null : fromBase64(res.body);
    return new Response(body as BodyInit | null, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}
