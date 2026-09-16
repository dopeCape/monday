// Nightly contract test: the conformance suite against a live Gmail account.
// Skipped without the TEST_GMAIL_* secrets (see README.md). The refresh token
// comes from a completed wizard run against the project's own Desktop client;
// the access token is minted here through the broker.

import { describe, test } from "bun:test";
import { createGmailProvider } from "../../src/providers/gmail/index.ts";
import { createTokenBroker } from "../../src/providers/oauth/tokens.ts";
import { providerConformance } from "../providers/conformance.ts";

const clientId = process.env.TEST_GMAIL_CLIENT_ID;
const clientSecret = process.env.TEST_GMAIL_CLIENT_SECRET;
const refreshToken = process.env.TEST_GMAIL_REFRESH_TOKEN;
const address = process.env.TEST_GMAIL_ADDRESS;
const topic = process.env.TEST_GMAIL_PUBSUB_TOPIC || null;

if (clientId && clientSecret && refreshToken && address) {
  providerConformance(
    `gmail contract (${address})`,
    async () => ({
      provider: createGmailProvider({ tokens: createTokenBroker() }),
      credentials: {
        address,
        auth: {
          kind: "oauth",
          user: address,
          issuer: "google",
          accessToken: "",
          refreshToken,
          expiresAt: new Date(0).toISOString(),
          client: { id: clientId, secret: clientSecret },
        },
        endpoint: { kind: "gmail", pubsubTopic: topic },
      },
    }),
    {
      send: process.env.TEST_CONTRACT_SEND === "1",
      pushWaitMs: topic ? 30_000 : 0,
      timeoutMs: 180_000,
    },
  );
} else {
  describe("gmail contract", () => {
    test.skip("set TEST_GMAIL_CLIENT_ID, TEST_GMAIL_CLIENT_SECRET, TEST_GMAIL_REFRESH_TOKEN and TEST_GMAIL_ADDRESS to run against Gmail", () => {});
  });
}
