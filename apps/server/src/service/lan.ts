// LAN access (server.lan.*, ADR 0006 amended for phones): the Sidecar binds
// 127.0.0.1 for its own client and, when the user turns it on, also listens
// on every interface at a fixed port so a phone on the same network can pair
// and sync. Off by default. The bind is decided once, at the start of the
// background service; a changed Setting says a restart is needed until then.
// Over TLS by default, with a certificate the Sidecar makes for itself and a
// phone pins by fingerprint.
//
// Pure: the entry reads the Settings and the interfaces and starts Bun.serve.

import { isPrivateHost, type LanStatus } from "@monday/shared";

export interface LanSettings {
  enabled: boolean;
  port: number;
  tls: boolean;
}

/** One address of a network interface, as node:os networkInterfaces() lists it. */
export interface InterfaceAddress {
  address: string;
  family: string | number;
  internal: boolean;
}

/** What the LAN listener binds: every interface, the Setting's port, TLS or not. */
export interface LanBind {
  /** Every interface in the app; a test binds loopback. */
  hostname: string;
  port: number;
  tls: boolean;
}

/** The listener this process runs, or null when it runs none (off, or not the Sidecar). */
export function lanBind(settings: LanSettings, mode: string): LanBind | null {
  if (mode !== "sidecar" || !settings.enabled) return null;
  return { hostname: "0.0.0.0", port: settings.port, tls: settings.tls };
}

/**
 * The IPv4 addresses a phone on the same network can reach: private, not
 * loopback, not link-local (a cable with no DHCP), in interface order.
 */
export function lanAddresses(
  interfaces: Record<string, readonly InterfaceAddress[] | undefined>,
): string[] {
  const out: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      const v4 = a.family === "IPv4" || a.family === 4;
      if (!v4 || a.internal) continue;
      if (a.address.startsWith("127.") || a.address.startsWith("169.254.")) continue;
      if (!isPrivateHost(a.address) || out.includes(a.address)) continue;
      out.push(a.address);
    }
  }
  return out;
}

export function lanUrls(addresses: readonly string[], bind: LanBind): string[] {
  const scheme = bind.tls ? "https" : "http";
  return addresses.map((a) => `${scheme}://${a}:${bind.port}`);
}

/** Paths the LAN listener refuses: a phone pairs by invite, never by the setup code or a requested code. */
export const LAN_REFUSED_PATHS: readonly string[] = ["/pair/setup", "/pair/start", "/pair/claim"];

export interface RunningLan {
  bind: LanBind;
  /** Whether Bun.serve took the port. */
  listening: boolean;
  fingerprint: string | null;
  error: string | null;
}

/** What the Devices panel and a Pairing invite show about the listener. */
export function lanStatus(
  saved: LanSettings,
  running: RunningLan | null,
  addresses: readonly string[],
): LanStatus {
  const restartNeeded = running
    ? !saved.enabled || saved.port !== running.bind.port || saved.tls !== running.bind.tls
    : saved.enabled;
  const listening = running?.listening ?? false;
  return {
    enabled: saved.enabled,
    listening,
    port: running?.bind.port ?? saved.port,
    tls: running?.bind.tls ?? saved.tls,
    urls: running && listening ? lanUrls(addresses, running.bind) : [],
    fingerprint: running?.bind.tls && listening ? running.fingerprint : null,
    error: running?.error ?? null,
    restartNeeded,
  };
}
