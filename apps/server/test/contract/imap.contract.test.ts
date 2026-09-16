// Nightly contract test: the conformance suite against a live IMAP and SMTP
// server. Skipped without TEST_IMAP_HOST, TEST_IMAP_USER and TEST_IMAP_PASS
// (see README.md).

import { describe, test } from "bun:test";
import { createImapProvider } from "../../src/providers/imap/index.ts";
import { providerConformance } from "../providers/conformance.ts";

const host = process.env.TEST_IMAP_HOST;
const user = process.env.TEST_IMAP_USER;
const pass = process.env.TEST_IMAP_PASS;

if (host && user && pass) {
  const smtpHost = process.env.TEST_SMTP_HOST ?? host.replace(/^imap/, "smtp");
  const smtpPort = Number(process.env.TEST_SMTP_PORT ?? 465);
  providerConformance(
    `imap contract (${host})`,
    async () => ({
      provider: createImapProvider(),
      credentials: {
        address: process.env.TEST_IMAP_ADDRESS ?? user,
        auth: { kind: "password", user, password: pass },
        endpoint: {
          kind: "imap",
          imap: { host, port: Number(process.env.TEST_IMAP_PORT ?? 993), tls: "tls" },
          smtp: { host: smtpHost, port: smtpPort, tls: smtpPort === 465 ? "tls" : "starttls" },
        },
      },
    }),
    { send: process.env.TEST_CONTRACT_SEND === "1", pushWaitMs: 15_000, timeoutMs: 120_000 },
  );
} else {
  describe("imap contract", () => {
    test.skip("set TEST_IMAP_HOST, TEST_IMAP_USER and TEST_IMAP_PASS to run against a live server", () => {});
  });
}
