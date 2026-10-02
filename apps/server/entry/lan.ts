// The Sidecar's LAN listener, Bun only (src/service/lan.ts has the rules).
// A second Bun.serve on 0.0.0.0:<server.lan.port> beside the loopback one,
// serving the same app and the same Changes feed socket, over TLS with the
// certificate kept in <data dir>/lan-tls/ (made once, 0600, reused so the
// fingerprint a phone pinned stays valid across restarts). The pairing routes
// a phone has no use for are refused here.

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { LanStatus } from "@monday/shared";
import type { Server, WebSocketHandler } from "bun";
import {
  certificateFingerprint,
  createSelfSignedCertificate,
  pemToDer,
} from "../src/crypto/self-signed.ts";
import {
  type InterfaceAddress,
  LAN_REFUSED_PATHS,
  type LanBind,
  type LanSettings,
  lanAddresses,
  lanStatus,
  type RunningLan,
} from "../src/service/lan.ts";

export const LAN_TLS_DIR = "lan-tls";

export interface LanCertificate {
  certPem: string;
  keyPem: string;
  fingerprint: string;
}

/** The LAN certificate in the data directory, made on first use. */
export async function loadOrCreateLanCertificate(dataDir: string): Promise<LanCertificate> {
  const dir = join(dataDir, LAN_TLS_DIR);
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  if (existsSync(certPath) && existsSync(keyPath)) {
    const [certPem, keyPem] = await Promise.all([
      readFile(certPath, "utf8"),
      readFile(keyPath, "utf8"),
    ]);
    const der = pemToDer(certPem);
    if (der) return { certPem, keyPem, fingerprint: await certificateFingerprint(der) };
  }
  const made = await createSelfSignedCertificate();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(keyPath, made.keyPem, { mode: 0o600 });
  await writeFile(certPath, made.certPem, { mode: 0o600 });
  await chmod(keyPath, 0o600).catch(() => {});
  return made;
}

export interface LanListenerOptions<T> {
  bind: LanBind | null;
  dataDir: string;
  fetch: (req: Request, server: Server<T>) => Promise<Response> | Response;
  websocket: WebSocketHandler<T>;
  /** The Settings as saved now, for "restart to apply". */
  saved: () => Promise<LanSettings>;
  interfaces?: () => Record<string, readonly InterfaceAddress[] | undefined>;
  log: (message: string) => void;
}

export interface LanListener {
  status(): Promise<LanStatus>;
  stop(): void;
}

export async function startLanListener<T>(options: LanListenerOptions<T>): Promise<LanListener> {
  const interfaces = options.interfaces ?? (() => networkInterfaces());
  let running: RunningLan | null = null;
  let server: Server<T> | null = null;
  const { bind } = options;
  if (bind) {
    let fingerprint: string | null = null;
    try {
      const cert = bind.tls ? await loadOrCreateLanCertificate(options.dataDir) : null;
      fingerprint = cert?.fingerprint ?? null;
      server = Bun.serve<T>({
        hostname: bind.hostname,
        port: bind.port,
        idleTimeout: 120,
        ...(cert ? { tls: { cert: cert.certPem, key: cert.keyPem } } : {}),
        fetch: (req, srv) => {
          if (LAN_REFUSED_PATHS.includes(new URL(req.url).pathname)) {
            return Response.json({ error: "pair_by_invite" }, { status: 403 });
          }
          return options.fetch(req, srv);
        },
        websocket: options.websocket,
      });
      // Port 0 (a test) is whatever Bun picked.
      running = {
        bind: { ...bind, port: server.port ?? bind.port },
        listening: true,
        fingerprint,
        error: null,
      };
      options.log(
        `listening for phones on ${bind.hostname}:${bind.port} over ${bind.tls ? "https" : "plain http"}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      running = { bind, listening: false, fingerprint, error: message };
      options.log(`could not listen for phones on port ${bind.port}: ${message}`);
    }
  }
  return {
    async status() {
      return lanStatus(await options.saved(), running, lanAddresses(interfaces()));
    },
    stop() {
      server?.stop(true);
    },
  };
}
