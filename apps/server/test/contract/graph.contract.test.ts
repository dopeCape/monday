// Nightly contract test: the conformance suite against a live Microsoft 365
// or Outlook.com mailbox through Graph. Skipped without the TEST_GRAPH_*
// secrets (see README.md). The refresh token comes from a completed wizard
// run against the project's own Entra app registration.

import { describe, test } from "bun:test";
import { createGraphProvider } from "../../src/providers/graph/index.ts";
import { createTokenBroker } from "../../src/providers/oauth/tokens.ts";
import { providerConformance } from "../providers/conformance.ts";

const clientId = process.env.TEST_GRAPH_CLIENT_ID;
const tenant = process.env.TEST_GRAPH_TENANT || "consumers";
const refreshToken = process.env.TEST_GRAPH_REFRESH_TOKEN;
const address = process.env.TEST_GRAPH_ADDRESS;

if (clientId && refreshToken && address) {
  providerConformance(
    `graph contract (${address})`,
    async () => ({
      provider: createGraphProvider({ tokens: createTokenBroker(), pollMs: 5_000 }),
      credentials: {
        address,
        auth: {
          kind: "oauth",
          user: address,
          issuer: "microsoft",
          accessToken: "",
          refreshToken,
          expiresAt: new Date(0).toISOString(),
          client: { id: clientId, tenant },
        },
        endpoint: { kind: "none" },
      },
    }),
    // The in-process watch is a delta poll, so the push wait only checks the plumbing.
    { send: process.env.TEST_CONTRACT_SEND === "1", pushWaitMs: 15_000, timeoutMs: 180_000 },
  );
} else {
  describe("graph contract", () => {
    test.skip("set TEST_GRAPH_CLIENT_ID, TEST_GRAPH_REFRESH_TOKEN and TEST_GRAPH_ADDRESS (and TEST_GRAPH_TENANT) to run against Microsoft Graph", () => {});
  });
}
