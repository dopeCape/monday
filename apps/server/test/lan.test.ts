// LAN access (server.lan.*): off by default, bound only by the Sidecar, the
// addresses a phone can try, "restart to apply", and the listener itself over
// pinned TLS with the pairing routes a phone has no use for refused.

import { afterAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { defaultSettings } from "@monday/shared";
import { loadOrCreateLanCertificate, startLanListener } from "../entry/lan.ts";
import { createSelfSignedCertificate } from "../src/crypto/self-signed.ts";
import { lanAddresses, lanBind, lanStatus, lanUrls } from "../src/service/lan.ts";

const dirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "monday-lan-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const shipped = defaultSettings();
const saved = {
  enabled: shipped["server.lan.enabled"],
  port: shipped["server.lan.port"],
  tls: shipped["server.lan.tls"],
};

/** The SHA-256 a TLS client sees, as base64url: what the phone compares with the QR code. */
function peerFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      const hex = socket.getPeerCertificate().fingerprint256.replaceAll(":", "");
      socket.end();
      resolve(Buffer.from(hex, "hex").toString("base64url"));
    });
    socket.on("error", reject);
  });
}

describe("the bind", () => {
  test("off by default, over TLS when on, and only for the Sidecar", () => {
    expect(saved).toEqual({ enabled: false, port: 47820, tls: true });
    expect(lanBind(saved, "sidecar")).toBeNull();
    expect(lanBind({ ...saved, enabled: true }, "sidecar")).toEqual({
      hostname: "0.0.0.0",
      port: 47820,
      tls: true,
    });
    expect(lanBind({ ...saved, enabled: true }, "container")).toBeNull();
  });

  test("the addresses a phone can try: private IPv4 only, no loopback or link-local", () => {
    const addresses = lanAddresses({
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      wlan0: [
        { address: "192.168.1.20", family: "IPv4", internal: false },
        { address: "fe80::1", family: "IPv6", internal: false },
      ],
      eth0: [{ address: "169.254.3.4", family: 4, internal: false }],
      tun0: [{ address: "203.0.113.5", family: "IPv4", internal: false }],
      docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
    });
    expect(addresses).toEqual(["192.168.1.20", "172.17.0.1"]);
    expect(lanUrls(addresses, { hostname: "0.0.0.0", port: 47820, tls: false })).toEqual([
      "http://192.168.1.20:47820",
      "http://172.17.0.1:47820",
    ]);
  });

  test("a changed Setting waits for a restart of the background service", () => {
    const bind = { hostname: "0.0.0.0", port: 47820, tls: true };
    const running = { bind, listening: true, fingerprint: "fp", error: null };
    const on = { ...saved, enabled: true };
    expect(lanStatus(on, running, ["10.0.0.2"])).toEqual({
      enabled: true,
      listening: true,
      port: 47820,
      tls: true,
      urls: ["https://10.0.0.2:47820"],
      fingerprint: "fp",
      error: null,
      restartNeeded: false,
    });
    expect(lanStatus({ ...on, port: 50000 }, running, []).restartNeeded).toBe(true);
    expect(lanStatus({ ...on, tls: false }, running, []).restartNeeded).toBe(true);
    expect(lanStatus(saved, running, []).restartNeeded).toBe(true);
    expect(lanStatus(on, null, []).restartNeeded).toBe(true);
    expect(lanStatus(saved, null, [])).toMatchObject({ listening: false, restartNeeded: false });
  });
});

describe("the certificate", () => {
  test("is a valid self-signed X.509 whose fingerprint is the DER's SHA-256", async () => {
    const made = await createSelfSignedCertificate({ now: new Date("2026-10-02T00:00:00Z") });
    const x = new X509Certificate(made.certPem);
    expect(x.subject).toBe("CN=monday");
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.subjectAltName).toBe("DNS:monday.local");
    expect(new Date(x.validTo).getUTCFullYear()).toBe(2036);
    expect(Buffer.from(x.fingerprint256.replaceAll(":", ""), "hex").toString("base64url")).toBe(
      made.fingerprint,
    );
  });

  test("is made once per data directory and kept, so a pinned phone stays paired", async () => {
    const dir = await tempDir();
    const first = await loadOrCreateLanCertificate(dir);
    const again = await loadOrCreateLanCertificate(dir);
    expect(again).toEqual(first);
    const mode = (await Bun.file(join(dir, "lan-tls", "key.pem")).stat()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("the listener", () => {
  test("serves the app over TLS with the pinned certificate and refuses code pairing", async () => {
    const dir = await tempDir();
    const listener = await startLanListener<unknown>({
      bind: { hostname: "127.0.0.1", port: 0, tls: true },
      dataDir: dir,
      fetch: () => Response.json({ ok: true }),
      websocket: { message() {} },
      saved: async () => ({ enabled: true, port: 0, tls: true }),
      interfaces: () => ({ wlan0: [{ address: "192.168.1.20", family: "IPv4", internal: false }] }),
      log: () => {},
    });
    try {
      const status = await listener.status();
      expect(status.listening).toBe(true);
      expect(status.error).toBeNull();
      const cert = await loadOrCreateLanCertificate(dir);
      expect(status.fingerprint).toBe(cert.fingerprint);
      expect(status.urls).toEqual([`https://192.168.1.20:${status.port}`]);
      expect(await peerFingerprint(status.port)).toBe(cert.fingerprint);

      const insecure = { tls: { rejectUnauthorized: false } } as RequestInit;
      const ok = await fetch(`https://127.0.0.1:${status.port}/health`, insecure);
      expect(await ok.json()).toEqual({ ok: true });
      for (const path of ["/pair/setup", "/pair/start", "/pair/claim"]) {
        const refused = await fetch(`https://127.0.0.1:${status.port}${path}`, {
          ...insecure,
          method: "POST",
        });
        expect(refused.status).toBe(403);
      }
    } finally {
      listener.stop();
    }
  });

  test("a taken port is reported, not fatal", async () => {
    const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    try {
      const listener = await startLanListener<unknown>({
        bind: { hostname: "127.0.0.1", port: taken.port ?? 0, tls: false },
        dataDir: await tempDir(),
        fetch: () => new Response(),
        websocket: { message() {} },
        saved: async () => ({ enabled: true, port: taken.port ?? 0, tls: false }),
        interfaces: () => ({}),
        log: () => {},
      });
      const status = await listener.status();
      expect(status.listening).toBe(false);
      expect(status.error).toBeTruthy();
      expect(status.urls).toEqual([]);
    } finally {
      taken.stop(true);
    }
  });

  test("no bind, no listener", async () => {
    const listener = await startLanListener<unknown>({
      bind: null,
      dataDir: await tempDir(),
      fetch: () => new Response(),
      websocket: { message() {} },
      saved: async () => saved,
      log: () => {},
    });
    expect(await listener.status()).toMatchObject({ enabled: false, listening: false, urls: [] });
  });
});
