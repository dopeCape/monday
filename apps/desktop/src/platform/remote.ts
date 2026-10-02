// A phone's one Server (ADR 0006, amended for phones). A phone runs no
// Sidecar: it is a Device of the user's monday, the desktop's background
// service reached over LAN access or a Cloud server. It pairs once by a
// Pairing invite (the QR code scanned, or the address and short code typed),
// keeps the Device token in the platform's secret store, and from then on is
// a client of that Server like any other: the Cache per Workspace, the
// Changes feed with reconnects, the Outbox.
//
// What a phone cannot do: anything with the root key (unlock, lock, the
// recovery file), add or revoke Devices, move the database. While the Server
// is locked it serves headers only, and the phone says so.
//
// No React and no DOM here: the pairing tests script fetch.

import {
  checkServerUrl,
  type DeviceKind,
  isPrivateHost,
  normalizeInviteCode,
  type PairingPayload,
  type PairingRedeemed,
  parsePairingPayload,
} from "@monday/shared";
import type { ServerTarget } from "./api.ts";
import type { FetchLike } from "./cloud.ts";
import type { Platform } from "./tauri.ts";

/** The paired Server as the phone keeps it. */
export interface RemoteTarget extends ServerTarget {
  deviceId: string;
  /** The Server's name: "Connected to {name}". */
  name: string;
  /** The LAN certificate this phone pinned at pairing; null for plain HTTP or a public certificate. */
  fingerprint: string | null;
}

/** The secret-store entry holding the phone's Server as JSON. */
export const REMOTE_SECRET_KEY = "server.remote";

export async function loadRemoteTarget(
  platform: Pick<Platform, "secretGet">,
): Promise<RemoteTarget | null> {
  const raw = await platform.secretGet(REMOTE_SECRET_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as Partial<RemoteTarget>;
    if (
      typeof t.baseUrl === "string" &&
      typeof t.token === "string" &&
      typeof t.deviceId === "string"
    ) {
      return {
        baseUrl: t.baseUrl,
        token: t.token,
        deviceId: t.deviceId,
        name: typeof t.name === "string" && t.name ? t.name : "monday",
        fingerprint: typeof t.fingerprint === "string" ? t.fingerprint : null,
      };
    }
  } catch {
    // A corrupt entry reads as not paired; pairing again rewrites it.
  }
  return null;
}

export async function saveRemoteTarget(
  platform: Pick<Platform, "secretSet" | "secretDelete">,
  target: RemoteTarget | null,
): Promise<void> {
  if (target) await platform.secretSet(REMOTE_SECRET_KEY, JSON.stringify(target));
  else await platform.secretDelete(REMOTE_SECRET_KEY);
}

/**
 * The fetch for one address: pinned to the certificate when the address is
 * https on a private network and a fingerprint was given, the plain one
 * otherwise (a public https address uses the system's trust; plain http on
 * a private network has nothing to pin).
 */
export function fetchFor(
  url: string,
  fingerprint: string | null,
  options: { fetch?: FetchLike | undefined; pinnedFetch?: ((fp: string) => FetchLike) | undefined },
): FetchLike {
  const plain: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  if (!fingerprint || !options.pinnedFetch) return plain;
  const u = new URL(url);
  return u.protocol === "https:" && isPrivateHost(u.hostname)
    ? options.pinnedFetch(fingerprint)
    : plain;
}

/* ------------------------------ Connecting ------------------------------ */

export type ConnectErrorCode =
  | "not_a_code"
  | "invalid_url"
  | "insecure"
  | "invalid_code"
  | "unreachable"
  | "rejected"
  | "too_many"
  | "pin";

export class ConnectError extends Error {
  constructor(
    readonly code: ConnectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectError";
  }
}

/** What the person gave the Connect screen. */
export type ConnectInput =
  | { kind: "scan"; text: string }
  | { kind: "manual"; url: string; code: string; fingerprint?: string | undefined };

export interface ConnectOptions {
  /** This phone's name as the Devices panel lists it. */
  name: string;
  kind?: DeviceKind;
  fetch?: FetchLike | undefined;
  pinnedFetch?: ((fingerprint: string) => FetchLike) | undefined;
}

interface Attempt {
  urls: string[];
  proof: { secret: string } | { code: string };
  fingerprint: string | null;
  name: string | null;
}

/** Turns the scanned text or the typed fields into what to try; throws ConnectError when it cannot. */
export function attemptOf(input: ConnectInput): Attempt {
  if (input.kind === "scan") {
    const payload: PairingPayload | null = parsePairingPayload(input.text);
    if (!payload) throw new ConnectError("not_a_code", "not a monday pairing code");
    return {
      urls: payload.urls,
      proof: { secret: payload.secret },
      fingerprint: payload.fingerprint,
      name: payload.name,
    };
  }
  const checked = checkServerUrl(input.url);
  if (!checked.ok) {
    throw new ConnectError(
      checked.reason === "insecure" ? "insecure" : "invalid_url",
      `cannot use ${input.url}`,
    );
  }
  const code = normalizeInviteCode(input.code);
  if (!code) throw new ConnectError("invalid_code", "the short code has eight characters");
  const fingerprint = input.fingerprint?.trim().replace(/=+$/, "") || null;
  return { urls: [checked.url], proof: { code }, fingerprint, name: null };
}

/**
 * Pairs this phone: tries each address in order and redeems the invite at the
 * first that answers. A refusal (used, expired, unknown) stops at once; a
 * certificate that is not the pinned one stops too, since the address
 * answered as someone else.
 */
export async function connectPhone(
  input: ConnectInput,
  options: ConnectOptions,
): Promise<RemoteTarget> {
  const attempt = attemptOf(input);
  let lastError: unknown = null;
  for (const baseUrl of attempt.urls) {
    const fetchFn = fetchFor(baseUrl, attempt.fingerprint, options);
    let res: Response;
    try {
      res = await fetchFn(`${baseUrl}/pair/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...attempt.proof,
          name: options.name,
          kind: options.kind ?? "phone",
        }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "PinMismatch") {
        throw new ConnectError("pin", `the certificate at ${baseUrl} is not the pinned one`);
      }
      lastError = error;
      continue;
    }
    if (res.status === 201) {
      const body = (await res.json()) as PairingRedeemed;
      return {
        baseUrl,
        token: body.token,
        deviceId: body.deviceId,
        name: body.name || attempt.name || "monday",
        fingerprint: baseUrl.startsWith("https:") ? attempt.fingerprint : null,
      };
    }
    if (res.status === 429) throw new ConnectError("too_many", "too many wrong codes");
    if ([400, 404, 409, 410].includes(res.status)) {
      throw new ConnectError("rejected", `the server answered ${res.status}`);
    }
    lastError = new Error(`the server answered ${res.status}`);
  }
  throw new ConnectError(
    "unreachable",
    lastError instanceof Error ? lastError.message : "no address answered",
  );
}

/* ------------------------------ Status ------------------------------ */

/** What the phone's status line says about its Server. */
export type RemoteState = "connecting" | "connected" | "locked" | "unreachable" | "revoked";

/**
 * The status from the last probe: no answer is unreachable, a 401 means this
 * phone was revoked (pair again), a locked Server serves headers only.
 */
export function remoteState(probe: {
  answered: boolean | null;
  status?: number;
  unlocked?: boolean;
}): RemoteState {
  if (probe.answered === null) return "connecting";
  if (!probe.answered) return "unreachable";
  if (probe.status === 401) return "revoked";
  if (probe.unlocked === false) return "locked";
  return "connected";
}

/** The Strings key for each state; {name} is filled with the Server's name. */
export const REMOTE_STATE_STRING = {
  connecting: "strings.mobile.status.connecting",
  connected: "strings.mobile.status.connected",
  locked: "strings.mobile.status.locked",
  unreachable: "strings.mobile.status.unreachable",
  revoked: "strings.mobile.status.revoked",
} as const satisfies Record<RemoteState, string>;

/**
 * One probe of the paired Server, through the pinned fetch when there is a
 * fingerprint: GET /devices/me says whether the token still opens it (a 401
 * is a revoked phone), GET /capabilities whether it is locked.
 */
export async function probeRemote(
  target: RemoteTarget,
  options: { fetch?: FetchLike | undefined; pinnedFetch?: ((fp: string) => FetchLike) | undefined },
): Promise<RemoteState> {
  const fetchFn = fetchFor(target.baseUrl, target.fingerprint, options);
  const init = { headers: { authorization: `Bearer ${target.token}` } };
  try {
    const me = await fetchFn(`${target.baseUrl}/devices/me`, init);
    if (!me.ok) return remoteState({ answered: true, status: me.status });
    const res = await fetchFn(`${target.baseUrl}/capabilities`, init);
    if (!res.ok) return remoteState({ answered: true, status: res.status });
    const caps = (await res.json()) as { unlocked?: boolean };
    return remoteState({ answered: true, status: res.status, unlocked: caps.unlocked !== false });
  } catch {
    return remoteState({ answered: false });
  }
}
