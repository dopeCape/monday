// IMAP Account discovery for onboarding (research, "Auto-configuration"):
// Thunderbird autoconfig at the domain's own URLs, then the ISPDB, then RFC
// 6186 SRV records, then host guessing on 993, then manual entry. Domains that
// only take XOAUTH2 (Gmail, Microsoft) come back as needsOAuth so onboarding
// routes them to the OAuth wizards: the well-known consumer domains at once,
// any other domain whose MX points at google.com or outlook.com after one DNS
// lookup, and anything that advertises AUTH=XOAUTH2 with LOGINDISABLED after
// the probe. Every network call is injectable, so the whole ladder is tested
// with a mocked fetch and DNS.

import { needsOAuth, oauthIssuerOfHost } from "./imap/auth.ts";
import type { HostPort, Tls } from "./types.ts";

export type OAuthIssuer = "google" | "microsoft";

export type DiscoverySource = "autoconfig" | "ispdb" | "srv" | "guess";

export type Discovery =
  | {
      kind: "found";
      source: DiscoverySource;
      imap: HostPort;
      smtp: HostPort;
      /** The username the provider expects: the full address or the local part. */
      username: string;
      /** Set when the provider takes only OAuth; the endpoints are still valid for XOAUTH2. */
      needsOAuth: OAuthIssuer | null;
    }
  | { kind: "needs-oauth"; issuer: OAuthIssuer; imap: HostPort | null; smtp: HostPort | null }
  | { kind: "manual"; tried: string[] };

export interface SrvRecord {
  name: string;
  port: number;
  priority: number;
}

export interface ProbeResult {
  /** Pre-login CAPABILITY atoms, uppercased. */
  capabilities: string[];
}

export interface DiscoveryDeps {
  fetch: (url: string) => Promise<Response>;
  /** SRV lookup; resolves to [] when the name does not exist. */
  resolveSrv: (name: string) => Promise<SrvRecord[]>;
  /** MX lookup, exchange hosts only; resolves to [] when the name does not exist. Optional. */
  resolveMx?: (domain: string) => Promise<string[]>;
  /** Connects over implicit TLS and reads CAPABILITY; rejects when the host is unreachable. */
  probe: (host: string, port: number) => Promise<ProbeResult>;
  timeoutMs?: number;
}

const KNOWN_OAUTH_DOMAINS: Record<string, OAuthIssuer> = {
  "gmail.com": "google",
  "googlemail.com": "google",
  "outlook.com": "microsoft",
  "hotmail.com": "microsoft",
  "live.com": "microsoft",
  "msn.com": "microsoft",
};

export const OAUTH_ENDPOINTS: Record<OAuthIssuer, { imap: HostPort; smtp: HostPort }> = {
  google: {
    imap: { host: "imap.gmail.com", port: 993, tls: "tls" },
    smtp: { host: "smtp.gmail.com", port: 465, tls: "tls" },
  },
  microsoft: {
    imap: { host: "outlook.office365.com", port: 993, tls: "tls" },
    smtp: { host: "smtp.office365.com", port: 587, tls: "starttls" },
  },
};

/** Which OAuth issuer hosts a domain's mail, judging by its MX exchanges. */
export function oauthIssuerOfMx(exchanges: string[]): OAuthIssuer | null {
  for (const raw of exchanges) {
    const host = raw.toLowerCase().replace(/\.$/, "");
    if (/(^|\.)google\.com$/.test(host) || /(^|\.)googlemail\.com$/.test(host)) return "google";
    if (/(^|\.)outlook\.com$/.test(host)) return "microsoft";
  }
  return null;
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0
    ? address.trim().toLowerCase()
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

export function autoconfigUrls(domain: string, address: string): string[] {
  const email = encodeURIComponent(address);
  return [
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${email}`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${email}`,
  ];
}

export function ispdbUrl(domain: string): string {
  return `https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`;
}

/* ------------------------------ Autoconfig XML ------------------------------ */

interface ServerEntry {
  type: string;
  hostname: string;
  port: number;
  socketType: string;
  authentication: string[];
  username: string;
}

function tagValues(block: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "gi");
  for (const m of block.matchAll(re)) out.push((m[1] ?? "").trim());
  return out;
}

/** The minimal reader the autoconfig format needs; no XML library. */
export function parseAutoconfig(xml: string): ServerEntry[] {
  const entries: ServerEntry[] = [];
  const re = /<(incomingServer|outgoingServer)\s+type="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const m of xml.matchAll(re)) {
    const block = m[3] ?? "";
    entries.push({
      type: (m[2] ?? "").toLowerCase(),
      hostname: tagValues(block, "hostname")[0] ?? "",
      port: Number(tagValues(block, "port")[0] ?? 0),
      socketType: (tagValues(block, "socketType")[0] ?? "").toUpperCase(),
      authentication: tagValues(block, "authentication").map((a) => a.toLowerCase()),
      username: tagValues(block, "username")[0] ?? "%EMAILADDRESS%",
    });
  }
  return entries;
}

function tlsOf(socketType: string): Tls {
  if (socketType === "SSL") return "tls";
  if (socketType === "STARTTLS") return "starttls";
  return "none";
}

function fillUsername(template: string, address: string): string {
  const at = address.indexOf("@");
  return template
    .replace(/%EMAILADDRESS%/gi, address)
    .replace(/%EMAILLOCALPART%/gi, at < 0 ? address : address.slice(0, at))
    .replace(/%EMAILDOMAIN%/gi, domainOf(address));
}

type Found = Extract<Discovery, { kind: "found" }>;

function fromAutoconfig(
  xml: string,
  address: string,
  source: "autoconfig" | "ispdb",
): Found | null {
  const entries = parseAutoconfig(xml);
  const imap = entries.find((e) => e.type === "imap" && e.hostname);
  const smtp = entries.find((e) => e.type === "smtp" && e.hostname);
  if (!imap || !smtp) return null;
  const oauthOnly =
    imap.authentication.length > 0 && imap.authentication.every((a) => a === "oauth2");
  const issuer = oauthIssuerOfHost(imap.hostname);
  return {
    kind: "found",
    source,
    imap: { host: imap.hostname, port: imap.port || 993, tls: tlsOf(imap.socketType) },
    smtp: { host: smtp.hostname, port: smtp.port || 587, tls: tlsOf(smtp.socketType) },
    username: fillUsername(imap.username, address),
    needsOAuth: oauthOnly && issuer ? issuer : null,
  };
}

/* ------------------------------ The ladder ------------------------------ */

async function fetchText(deps: DiscoveryDeps, url: string): Promise<string | null> {
  try {
    const response = await withTimeout(deps.fetch(url), deps.timeoutMs ?? 5_000);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function srv(deps: DiscoveryDeps, name: string): Promise<SrvRecord | null> {
  try {
    const records = await withTimeout(deps.resolveSrv(name), deps.timeoutMs ?? 5_000);
    const usable = records.filter((r) => r.name && r.name !== "." && r.port > 0);
    usable.sort((a, b) => a.priority - b.priority);
    return usable[0] ?? null;
  } catch {
    return null;
  }
}

async function probed(
  deps: DiscoveryDeps,
  host: string,
  port: number,
): Promise<ProbeResult | null> {
  try {
    return await withTimeout(deps.probe(host, port), deps.timeoutMs ?? 5_000);
  } catch {
    return null;
  }
}

/** Runs the ladder for an address. Never throws; "manual" lists what was tried. */
export async function discover(address: string, deps: DiscoveryDeps): Promise<Discovery> {
  const domain = domainOf(address);
  const tried: string[] = [];

  const known = KNOWN_OAUTH_DOMAINS[domain];
  if (known) return { kind: "needs-oauth", issuer: known, ...OAUTH_ENDPOINTS[known] };

  // 0. A custom domain hosted at Google or Microsoft: the MX says so.
  if (deps.resolveMx) {
    tried.push(`MX ${domain}`);
    const exchanges = await withTimeout(deps.resolveMx(domain), deps.timeoutMs ?? 5_000).catch(
      () => [] as string[],
    );
    const hosted = oauthIssuerOfMx(exchanges);
    if (hosted) return { kind: "needs-oauth", issuer: hosted, ...OAUTH_ENDPOINTS[hosted] };
  }

  // 1. The domain's own autoconfig, then the ISPDB.
  for (const url of autoconfigUrls(domain, address)) {
    tried.push(url);
    const xml = await fetchText(deps, url);
    const found = xml ? fromAutoconfig(xml, address, "autoconfig") : null;
    if (found) return oauthGate(found, deps);
  }
  {
    const url = ispdbUrl(domain);
    tried.push(url);
    const xml = await fetchText(deps, url);
    const found = xml ? fromAutoconfig(xml, address, "ispdb") : null;
    if (found) return oauthGate(found, deps);
  }

  // 2. RFC 6186 SRV, with the RFC 8314 submissions record first.
  tried.push(`_imaps._tcp.${domain}`);
  const imaps = await srv(deps, `_imaps._tcp.${domain}`);
  if (imaps) {
    const submissions = await srv(deps, `_submissions._tcp.${domain}`);
    const submission = submissions ? null : await srv(deps, `_submission._tcp.${domain}`);
    const smtp: HostPort = submissions
      ? { host: submissions.name, port: submissions.port, tls: "tls" }
      : submission
        ? { host: submission.name, port: submission.port, tls: "starttls" }
        : { host: imaps.name.replace(/^imap/, "smtp"), port: 465, tls: "tls" };
    return oauthGate(
      {
        kind: "found",
        source: "srv",
        imap: { host: imaps.name, port: imaps.port, tls: "tls" },
        smtp,
        username: address,
        needsOAuth: null,
      },
      deps,
    );
  }

  // 3. Guess imap. and mail. on 993 and read the greeting's capabilities.
  for (const host of [`imap.${domain}`, `mail.${domain}`]) {
    tried.push(`${host}:993`);
    const result = await probed(deps, host, 993);
    if (!result) continue;
    const smtpHost = host.startsWith("imap.") ? `smtp.${domain}` : host;
    return oauthGate(
      {
        kind: "found",
        source: "guess",
        imap: { host, port: 993, tls: "tls" },
        smtp: { host: smtpHost, port: 465, tls: "tls" },
        username: address,
        needsOAuth: null,
      },
      deps,
    );
  }

  return { kind: "manual", tried };
}

/** Probes the found IMAP host; AUTH=XOAUTH2 with LOGINDISABLED means OAuth only. */
async function oauthGate(found: Found, deps: DiscoveryDeps): Promise<Discovery> {
  if (found.needsOAuth) {
    return { kind: "needs-oauth", issuer: found.needsOAuth, imap: found.imap, smtp: found.smtp };
  }
  if (found.imap.tls !== "tls") return found;
  const result = await probed(deps, found.imap.host, found.imap.port);
  if (!result || !needsOAuth(result.capabilities)) return found;
  const issuer = oauthIssuerOfHost(found.imap.host);
  if (!issuer) return found;
  return { kind: "needs-oauth", issuer, imap: found.imap, smtp: found.smtp };
}

/* ------------------------------ Default dependencies (Node and Bun) ------------------------------ */

export async function defaultDiscoveryDeps(): Promise<DiscoveryDeps> {
  const dns = await import("node:dns/promises");
  const tls = await import("node:tls");
  return {
    fetch: (url) => fetch(url, { redirect: "follow" }),
    resolveSrv: async (name) => {
      try {
        const records = await dns.resolveSrv(name);
        return records.map((r) => ({ name: r.name, port: r.port, priority: r.priority }));
      } catch {
        return [];
      }
    },
    resolveMx: async (domain) => {
      try {
        const records = await dns.resolveMx(domain);
        return records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
      } catch {
        return [];
      }
    },
    probe: (host, port) =>
      new Promise<ProbeResult>((resolve, reject) => {
        const socket = tls.connect({ host, port, servername: host }, () => {
          socket.write("a1 CAPABILITY\r\n");
        });
        let text = "";
        const finish = () => {
          const caps = new Set<string>();
          for (const line of text.split(/\r?\n/)) {
            const m = line.match(/CAPABILITY\s+([^\]]*)/i);
            if (!m) continue;
            for (const atom of (m[1] ?? "").split(/\s+/)) if (atom) caps.add(atom.toUpperCase());
          }
          socket.destroy();
          resolve({ capabilities: [...caps] });
        };
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          text += chunk;
          if (/^a1 (OK|NO|BAD)/m.test(text)) finish();
        });
        socket.on("error", reject);
        socket.setTimeout(5_000, () => {
          socket.destroy();
          reject(new Error("probe timeout"));
        });
      }),
  };
}
