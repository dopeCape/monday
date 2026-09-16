import { describe, expect, test } from "bun:test";
import {
  autoconfigUrls,
  type DiscoveryDeps,
  discover,
  ispdbUrl,
  parseAutoconfig,
  type SrvRecord,
} from "../../src/providers/autoconfig.ts";

const FASTMAIL_XML = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="fastmail.com">
    <domain>fastmail.com</domain>
    <incomingServer type="imap">
      <hostname>imap.fastmail.com</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.fastmail.com</hostname>
      <port>465</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

const OAUTH_XML = FASTMAIL_XML.replace(/imap\.fastmail\.com/, "imap.gmail.com")
  .replace(/smtp\.fastmail\.com/, "smtp.gmail.com")
  .replace(
    /<authentication>password-cleartext<\/authentication>/g,
    "<authentication>OAuth2</authentication>",
  );

interface MockOptions {
  pages?: Record<string, string>;
  srv?: Record<string, SrvRecord[]>;
  probes?: Record<string, string[]>;
}

function deps(options: MockOptions): DiscoveryDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(`fetch ${url}`);
      const page = options.pages?.[url];
      return page === undefined
        ? new Response("not found", { status: 404 })
        : new Response(page, { status: 200 });
    },
    resolveSrv: async (name) => {
      calls.push(`srv ${name}`);
      return options.srv?.[name] ?? [];
    },
    probe: async (host, port) => {
      calls.push(`probe ${host}:${port}`);
      const caps = options.probes?.[`${host}:${port}`];
      if (!caps) throw new Error("unreachable");
      return { capabilities: caps };
    },
    timeoutMs: 1_000,
  };
}

describe("autoconfig", () => {
  test("URL ladder matches Thunderbird's order", () => {
    expect(autoconfigUrls("example.test", "a@example.test")).toEqual([
      "https://autoconfig.example.test/mail/config-v1.1.xml?emailaddress=a%40example.test",
      "https://example.test/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=a%40example.test",
    ]);
    expect(ispdbUrl("example.test")).toBe("https://autoconfig.thunderbird.net/v1.1/example.test");
  });

  test("parses incoming and outgoing servers", () => {
    const entries = parseAutoconfig(FASTMAIL_XML);
    expect(entries.map((e) => [e.type, e.hostname, e.port, e.socketType])).toEqual([
      ["imap", "imap.fastmail.com", 993, "SSL"],
      ["smtp", "smtp.fastmail.com", 465, "SSL"],
    ]);
  });

  test("the domain's own autoconfig wins over the ISPDB", async () => {
    const d = deps({
      pages: {
        "https://autoconfig.fastmail.com/mail/config-v1.1.xml?emailaddress=a%40fastmail.com":
          FASTMAIL_XML,
      },
      probes: { "imap.fastmail.com:993": ["IMAP4REV1", "AUTH=PLAIN", "AUTH=XOAUTH2"] },
    });
    const result = await discover("a@fastmail.com", d);
    expect(result).toEqual({
      kind: "found",
      source: "autoconfig",
      imap: { host: "imap.fastmail.com", port: 993, tls: "tls" },
      smtp: { host: "smtp.fastmail.com", port: 465, tls: "tls" },
      username: "a@fastmail.com",
      needsOAuth: null,
    });
    expect(d.calls.some((c) => c.includes("thunderbird.net"))).toBe(false);
  });

  test("falls through to the ISPDB", async () => {
    const d = deps({
      pages: { "https://autoconfig.thunderbird.net/v1.1/fastmail.com": FASTMAIL_XML },
      probes: { "imap.fastmail.com:993": ["IMAP4REV1", "AUTH=PLAIN"] },
    });
    const result = await discover("a@fastmail.com", d);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.source).toBe("ispdb");
  });

  test("an OAuth2-only ISPDB entry routes to the OAuth wizard", async () => {
    const d = deps({ pages: { "https://autoconfig.thunderbird.net/v1.1/corp.test": OAUTH_XML } });
    const result = await discover("a@corp.test", d);
    expect(result).toEqual({
      kind: "needs-oauth",
      issuer: "google",
      imap: { host: "imap.gmail.com", port: 993, tls: "tls" },
      smtp: { host: "smtp.gmail.com", port: 465, tls: "tls" },
    });
  });

  test("well-known consumer domains skip the network", async () => {
    const d = deps({});
    const result = await discover("someone@outlook.com", d);
    expect(result.kind).toBe("needs-oauth");
    if (result.kind === "needs-oauth") expect(result.issuer).toBe("microsoft");
    expect(d.calls).toEqual([]);
  });

  test("RFC 6186 SRV records, submissions before submission", async () => {
    const d = deps({
      srv: {
        "_imaps._tcp.srv.test": [{ name: "imap.srv.test", port: 993, priority: 0 }],
        "_submissions._tcp.srv.test": [{ name: "smtp.srv.test", port: 465, priority: 0 }],
      },
      probes: { "imap.srv.test:993": ["IMAP4REV1", "AUTH=PLAIN"] },
    });
    const result = await discover("a@srv.test", d);
    expect(result).toEqual({
      kind: "found",
      source: "srv",
      imap: { host: "imap.srv.test", port: 993, tls: "tls" },
      smtp: { host: "smtp.srv.test", port: 465, tls: "tls" },
      username: "a@srv.test",
      needsOAuth: null,
    });
  });

  test("host guessing on 993, then manual", async () => {
    const guessed = await discover(
      "a@guess.test",
      deps({ probes: { "mail.guess.test:993": ["IMAP4REV1", "AUTH=PLAIN"] } }),
    );
    expect(guessed).toEqual({
      kind: "found",
      source: "guess",
      imap: { host: "mail.guess.test", port: 993, tls: "tls" },
      smtp: { host: "mail.guess.test", port: 465, tls: "tls" },
      username: "a@guess.test",
      needsOAuth: null,
    });
    const manual = await discover("a@nowhere.test", deps({}));
    expect(manual.kind).toBe("manual");
    if (manual.kind === "manual") {
      expect(manual.tried).toContain("_imaps._tcp.nowhere.test");
      expect(manual.tried).toContain("imap.nowhere.test:993");
    }
  });

  test("AUTH=XOAUTH2 plus LOGINDISABLED on a Microsoft host means OAuth", async () => {
    const d = deps({
      srv: { "_imaps._tcp.corp.test": [{ name: "outlook.office365.com", port: 993, priority: 0 }] },
      probes: {
        "outlook.office365.com:993": [
          "IMAP4",
          "IMAP4REV1",
          "AUTH=XOAUTH2",
          "LOGINDISABLED",
          "IDLE",
        ],
      },
    });
    const result = await discover("a@corp.test", d);
    expect(result.kind).toBe("needs-oauth");
    if (result.kind === "needs-oauth") expect(result.issuer).toBe("microsoft");
  });

  test("a self-hosted server that also offers XOAUTH2 stays on passwords", async () => {
    const d = deps({
      srv: { "_imaps._tcp.self.test": [{ name: "imap.self.test", port: 993, priority: 0 }] },
      probes: { "imap.self.test:993": ["IMAP4REV1", "AUTH=XOAUTH2", "AUTH=PLAIN", "IDLE"] },
    });
    const result = await discover("a@self.test", d);
    expect(result.kind).toBe("found");
  });
});
