// The second Server target (ADR 0005, ADR 0008): after the upgrade this
// Device holds the Sidecar on loopback and the Cloud URL with its Device
// token. The picker decides which one the wake connection and the Outbox go
// to: the preferred kind (the server.prefer Setting) when it is reachable,
// the other one otherwise, and either serves the same database. The Cloud
// target lives in the OS keychain, per machine, like the token ADR 0006
// describes.
//
// No React and no DOM here, so the picker and the pairing flow test with a
// scripted fetch.

import type { ServerTarget } from "./api.ts";
import type { Platform } from "./tauri.ts";

export type ServerKind = "sidecar" | "cloud";

/** The one shape of fetch the pairing flow needs, so tests script it without the full global type. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface CloudTarget extends ServerTarget {
  deviceId: string;
}

/** The keychain entry holding the Cloud target as JSON. */
export const CLOUD_SECRET_KEY = "server.cloud";

export async function loadCloudTarget(platform: Platform): Promise<CloudTarget | null> {
  const raw = await platform.secretGet(CLOUD_SECRET_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CloudTarget>;
    if (
      typeof parsed.baseUrl === "string" &&
      typeof parsed.token === "string" &&
      typeof parsed.deviceId === "string"
    ) {
      return { baseUrl: parsed.baseUrl, token: parsed.token, deviceId: parsed.deviceId };
    }
  } catch {
    // A corrupt entry reads as no Cloud; pairing again rewrites it.
  }
  return null;
}

export async function saveCloudTarget(
  platform: Platform,
  target: CloudTarget | null,
): Promise<void> {
  if (target) await platform.secretSet(CLOUD_SECRET_KEY, JSON.stringify(target));
  else await platform.secretDelete(CLOUD_SECRET_KEY);
}

/** Trims and normalises what the user typed: no trailing slash, https unless told otherwise. */
export function normalizeCloudUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const withScheme = /^[a-z]+:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/* ------------------------------ Pairing (ADR 0006) ------------------------------ */

export type PairOutcome =
  | { status: "paired"; target: CloudTarget }
  | {
      /** The Cloud already has Devices: this code must be confirmed from one of them. */
      status: "confirm";
      code: string;
      expiresAt: string;
      /** Polls until confirmed; resolves paired, or throws PairError("expired"). */
      claim: () => Promise<CloudTarget>;
    };

export class PairError extends Error {
  constructor(
    readonly code:
      | "unreachable"
      | "invalid_setup_code"
      | "expired"
      | "already_used"
      | "unknown"
      | "insecure",
    message: string,
  ) {
    super(message);
    this.name = "PairError";
  }
}

export interface PairCloudOptions {
  /** This Device's name as the Cloud lists it. */
  name: string;
  fetch?: FetchLike;
  /** Plain http:// is refused unless the server.insecure_allowed Setting says otherwise. */
  insecureAllowed?: boolean;
  /** Milliseconds between claim polls. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

async function post(
  fetchFn: FetchLike,
  url: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new PairError("unreachable", error instanceof Error ? error.message : String(error));
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Not JSON: the status carries the meaning.
  }
  return { status: res.status, json };
}

/**
 * Pairs this Device with a Cloud at `baseUrl` using the code the user entered:
 * the one-time setup code on a fresh Cloud, or a pairing code another Device
 * must confirm when the Cloud already has Devices (for instance after the
 * database copy carried them over).
 */
export async function pairCloud(
  baseUrl: string,
  code: string,
  options: PairCloudOptions,
): Promise<PairOutcome> {
  const fetchFn: FetchLike = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = options.pollMs ?? 2_000;
  if (baseUrl.startsWith("http://") && !options.insecureAllowed) {
    throw new PairError(
      "insecure",
      "plain http is off; allow it in Settings for a private network",
    );
  }
  const setup = await post(fetchFn, `${baseUrl}/pair/setup`, {
    setupCode: code.trim(),
    name: options.name,
  });
  if (setup.status === 201) {
    return {
      status: "paired",
      target: {
        baseUrl,
        token: String(setup.json.token),
        deviceId: String(setup.json.deviceId),
      },
    };
  }
  if (setup.status === 403) {
    throw new PairError("invalid_setup_code", "that setup code is not the one this Cloud printed");
  }
  if (setup.status !== 409) {
    throw new PairError("unknown", `the Cloud answered ${setup.status} to the setup code`);
  }
  // Setup is done: ask for a pairing code an existing Device confirms.
  const start = await post(fetchFn, `${baseUrl}/pair/start`, { name: options.name });
  if (start.status !== 201) {
    throw new PairError("unknown", `the Cloud answered ${start.status} to the pairing request`);
  }
  const secret = String(start.json.secret);
  return {
    status: "confirm",
    code: String(start.json.code),
    expiresAt: String(start.json.expiresAt),
    claim: async () => {
      for (;;) {
        const claim = await post(fetchFn, `${baseUrl}/pair/claim`, { secret });
        if (claim.status === 200) {
          return {
            baseUrl,
            token: String(claim.json.token),
            deviceId: String(claim.json.deviceId),
          };
        }
        if (claim.status === 410) throw new PairError("expired", "the pairing code expired");
        if (claim.status === 409) throw new PairError("already_used", "the code was already used");
        if (claim.status !== 202) {
          throw new PairError("unknown", `the Cloud answered ${claim.status} while pairing`);
        }
        await sleep(pollMs);
      }
    },
  };
}

/* ------------------------------ Picker ------------------------------ */

export interface Targets {
  sidecar: ServerTarget | null;
  cloud: ServerTarget | null;
}

export interface Picked {
  kind: ServerKind;
  target: ServerTarget;
}

export interface TargetPickerOptions {
  targets: () => Targets;
  prefer: () => ServerKind;
  /** Whether a target answers; the Shell probes /health. */
  probe: (target: ServerTarget) => Promise<boolean>;
}

export interface TargetPicker {
  /** The target requests go to right now, or null when none is configured. Pure. */
  current(): Picked | null;
  /** Probes every configured target and re-picks. */
  refresh(): Promise<Picked | null>;
  /** A request to this target failed to get an answer; the other one is used until the next probe. */
  markUnreachable(target: ServerTarget): void;
  /** Called when a probe or a failed request changed the picked target. */
  subscribe(listener: (picked: Picked | null) => void): () => void;
}

export function createTargetPicker(options: TargetPickerOptions): TargetPicker {
  const unreachable = new Set<string>();
  const listeners = new Set<(picked: Picked | null) => void>();
  let last: string | null = null;

  const pick = (): Picked | null => {
    const t = options.targets();
    const order: ServerKind[] =
      options.prefer() === "cloud" ? ["cloud", "sidecar"] : ["sidecar", "cloud"];
    const configured = order
      .map((kind) => ({ kind, target: t[kind] }))
      .filter((p): p is Picked => p.target !== null);
    return configured.find((p) => !unreachable.has(p.target.baseUrl)) ?? configured[0] ?? null;
  };

  const announce = (picked: Picked | null) => {
    const key = picked ? `${picked.kind}:${picked.target.baseUrl}` : null;
    if (key === last) return;
    last = key;
    for (const l of listeners) l(picked);
  };

  return {
    current: pick,
    async refresh() {
      const t = options.targets();
      await Promise.all(
        (["sidecar", "cloud"] as const).map(async (kind) => {
          const target = t[kind];
          if (!target) return;
          const ok = await options.probe(target).catch(() => false);
          if (ok) unreachable.delete(target.baseUrl);
          else unreachable.add(target.baseUrl);
        }),
      );
      const picked = pick();
      announce(picked);
      return picked;
    },
    markUnreachable(target) {
      unreachable.add(target.baseUrl);
      announce(pick());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
