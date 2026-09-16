// Nightly contract test: the conformance suite against a live JMAP server.
// Skipped without TEST_JMAP_URL and TEST_JMAP_TOKEN (see README.md).

import { describe, test } from "bun:test";
import { createJmapProvider } from "../../src/providers/jmap/index.ts";
import { providerConformance } from "../providers/conformance.ts";

const url = process.env.TEST_JMAP_URL;
const token = process.env.TEST_JMAP_TOKEN;

if (url && token) {
  providerConformance(
    `jmap contract (${new URL(url).host})`,
    async () => ({
      provider: createJmapProvider(),
      credentials: {
        address: process.env.TEST_JMAP_ADDRESS ?? "",
        auth: { kind: "token", token },
        endpoint: { kind: "jmap", sessionUrl: url },
      },
    }),
    { send: process.env.TEST_CONTRACT_SEND === "1", pushWaitMs: 15_000, timeoutMs: 120_000 },
  );
} else {
  describe("jmap contract", () => {
    test.skip("set TEST_JMAP_URL and TEST_JMAP_TOKEN to run against a live server", () => {});
  });
}
