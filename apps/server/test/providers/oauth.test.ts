import { describe, expect, test } from "bun:test";
import { generateFixture } from "../../src/providers/fake/fixture.ts";
import { createOAuthFlow } from "../../src/providers/oauth/flow.ts";
import {
  GOOGLE_SCOPES,
  MICROSOFT_SCOPES,
  microsoftIssuer,
  normalizeTenant,
} from "../../src/providers/oauth/issuers.ts";
import {
  base64url,
  challengeOf,
  decodeBase64url,
  generateVerifier,
} from "../../src/providers/oauth/pkce.ts";
import { createTokenBroker } from "../../src/providers/oauth/tokens.ts";
import {
  validateGoogleClient,
  validateMicrosoftClient,
} from "../../src/providers/oauth/validate.ts";
import type { OAuthAuth } from "../../src/providers/types.ts";
import { createGmailServer } from "./gmail-server.ts";
import { createGraphServer } from "./graph-server.ts";

const fixture = generateFixture();

describe("PKCE", () => {
  test("S256 challenge matches RFC 7636 appendix B", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await challengeOf(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("verifiers are 43 unreserved characters and base64url round-trips", () => {
    const v = generateVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateVerifier()).not.toBe(v);
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(decodeBase64url(base64url(bytes))).toEqual(bytes);
    const big = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(decodeBase64url(base64url(big))).toEqual(big);
  });
});

describe("OAuth flow", () => {
  test("start builds a Google authorization URL with PKCE, offline access and the Desktop client's loopback", async () => {
    const flow = createOAuthFlow();
    const started = await flow.start({
      provider: "google",
      client: { id: "1234-abc.apps.googleusercontent.com", secret: "GOCSPX-secret" },
      path: "api",
      redirectUri: "http://127.0.0.1:43123/callback",
      pubsubTopic: "projects/p/topics/t",
    });
    const url = new URL(started.url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("1234-abc.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:43123/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe(started.state);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(GOOGLE_SCOPES.api);
    const pending = flow.pending(started.state);
    expect(await challengeOf(pending?.verifier ?? "")).toBe(
      url.searchParams.get("code_challenge") ?? "",
    );
    expect(url.searchParams.has("client_secret")).toBe(false);
  });

  test("start builds an Entra URL under the tenant with the delegated scopes", async () => {
    const flow = createOAuthFlow();
    const started = await flow.start({
      provider: "microsoft",
      client: { id: "12345678-1234-1234-1234-123456789abc", tenant: "contoso.onmicrosoft.com" },
      path: "api",
      redirectUri: "http://localhost:43123",
    });
    const url = new URL(started.url);
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(MICROSOFT_SCOPES.api);
    expect(MICROSOFT_SCOPES.api).toEqual([
      "Mail.ReadWrite",
      "Mail.Send",
      "MailboxSettings.Read",
      "Calendars.ReadWrite",
      "User.Read",
      "offline_access",
    ]);
    expect(normalizeTenant("")).toBe("common");
    expect(microsoftIssuer("imap", "consumers").scopes).toContain(
      "https://outlook.office.com/IMAP.AccessAsUser.All",
    );
    expect(microsoftIssuer("api", "consumers").usesClientSecret).toBe(false);
  });

  test("finish exchanges the code with the verifier at Google and learns the address", async () => {
    const server = createGmailServer(fixture);
    const flow = createOAuthFlow({ fetch: server.fetch, now: () => 1_000_000 });
    const started = await flow.start({
      provider: "google",
      client: { id: "1234-abc.apps.googleusercontent.com", secret: "GOCSPX-secret" },
      path: "api",
      redirectUri: "http://127.0.0.1:5000/callback",
      pubsubTopic: "projects/p/topics/t",
    });
    const challenge = new URL(started.url).searchParams.get("code_challenge") ?? "";
    // A code issued for another challenge is refused: PKCE holds.
    const wrong = server.issueCode("http://127.0.0.1:5000/callback", "other-challenge");
    await expect(flow.finish(started.state, wrong)).rejects.toMatchObject({ code: "auth" });
    // The state is single-use; start again for the good code.
    const again = await flow.start({
      provider: "google",
      client: { id: "1234-abc.apps.googleusercontent.com", secret: "GOCSPX-secret" },
      path: "api",
      redirectUri: "http://127.0.0.1:5000/callback",
      pubsubTopic: "projects/p/topics/t",
    });
    const goodChallenge = new URL(again.url).searchParams.get("code_challenge") ?? "";
    expect(goodChallenge).not.toBe(challenge);
    const code = server.issueCode("http://127.0.0.1:5000/callback", goodChallenge);
    const finished = await flow.finish(again.state, code);
    expect(finished.address).toBe(fixture.address);
    expect(finished.pubsubTopic).toBe("projects/p/topics/t");
    expect(finished.auth).toMatchObject({
      kind: "oauth",
      issuer: "google",
      accessToken: server.accessToken,
      refreshToken: server.refreshToken,
      client: { id: "1234-abc.apps.googleusercontent.com", secret: "GOCSPX-secret" },
    });
    expect(Date.parse(finished.auth.expiresAt ?? "")).toBe(1_000_000 + 3599 * 1000);
    expect(flow.pending(again.state)).toBeNull();
    await expect(flow.finish(again.state, code)).rejects.toMatchObject({ code: "auth" });
  });

  test("finish against Entra sends no client secret and reads /me", async () => {
    const server = createGraphServer(fixture);
    const flow = createOAuthFlow({ fetch: server.fetch });
    const started = await flow.start({
      provider: "microsoft",
      client: { id: "12345678-1234-1234-1234-123456789abc", tenant: "consumers" },
      path: "api",
      redirectUri: "http://localhost:5001",
    });
    const challenge = new URL(started.url).searchParams.get("code_challenge") ?? "";
    const code = server.issueCode("http://localhost:5001", challenge);
    const finished = await flow.finish(started.state, code);
    expect(finished.address).toBe(fixture.address);
    expect(finished.auth.issuer).toBe("microsoft");
    expect(finished.auth.client?.tenant).toBe("consumers");
  });

  test("a started flow expires", async () => {
    let t = 0;
    const flow = createOAuthFlow({ now: () => t, ttlMs: 1000 });
    const started = await flow.start({
      provider: "google",
      client: { id: "x.apps.googleusercontent.com" },
      path: "api",
      redirectUri: "http://127.0.0.1:1/callback",
    });
    t = 2000;
    expect(flow.pending(started.state)).toBeNull();
  });
});

describe("token broker", () => {
  test("refreshes near expiry through the stored client, once per token, and reports the new Auth", async () => {
    const server = createGmailServer(fixture);
    let t = 1_000_000;
    const persisted: string[] = [];
    const broker = createTokenBroker({
      fetch: server.fetch,
      now: () => t,
      skewMs: 60_000,
      onRefreshed: async (auth) => {
        persisted.push(auth.accessToken);
      },
    });
    const auth: OAuthAuth = {
      kind: "oauth",
      user: fixture.address,
      issuer: "google",
      accessToken: server.accessToken,
      refreshToken: server.refreshToken,
      expiresAt: new Date(t + 3600_000).toISOString(),
      client: { id: "1234-abc.apps.googleusercontent.com", secret: "GOCSPX-secret" },
    };
    expect(await broker.access(auth)).toBe("access-0");
    expect(server.refreshes).toBe(0);
    t += 3600_000 - 30_000;
    const [a, b] = await Promise.all([broker.access(auth), broker.access(auth)]);
    expect(a).toBe(b);
    expect(server.refreshes).toBe(1);
    expect(auth.accessToken).toBe(server.accessToken);
    expect(persisted).toEqual([server.accessToken]);
    expect(Date.parse(auth.expiresAt ?? "")).toBe(t + 3599 * 1000);
    await broker.access(auth, { force: true });
    expect(server.refreshes).toBe(2);
    await expect(
      broker.access({ ...auth, refreshToken: "revoked" }, { force: true }),
    ).rejects.toMatchObject({ code: "auth" });
    const { client: _client, ...noClient } = auth;
    await expect(broker.access(noClient, { force: true })).rejects.toMatchObject({ code: "auth" });
  });

  test("Entra rotates the refresh token on every use", async () => {
    const server = createGraphServer(fixture);
    const broker = createTokenBroker({ fetch: server.fetch });
    const auth: OAuthAuth = {
      kind: "oauth",
      user: fixture.address,
      issuer: "microsoft",
      accessToken: server.accessToken,
      refreshToken: server.refreshToken,
      expiresAt: new Date(0).toISOString(),
      client: { id: "12345678-1234-1234-1234-123456789abc", tenant: "consumers" },
    };
    const before = auth.refreshToken;
    await broker.access(auth);
    expect(auth.refreshToken).not.toBe(before);
    expect(auth.refreshToken).toBe(server.refreshToken);
  });
});

describe("live validation", () => {
  test("Google: tells a missing client, a bad secret and a good pair apart", async () => {
    const server = createGmailServer(fixture);
    const deps = { fetch: server.fetch };
    expect(await validateGoogleClient({ clientId: "" }, deps)).toMatchObject({
      ok: false,
      field: "clientId",
    });
    expect(await validateGoogleClient({ clientId: "not-a-google-id" }, deps)).toMatchObject({
      ok: false,
      field: "clientId",
    });
    expect(
      await validateGoogleClient(
        { clientId: "9999.apps.googleusercontent.com", clientSecret: "x" },
        deps,
      ),
    ).toMatchObject({ ok: false, field: "clientId" });
    expect(
      await validateGoogleClient({ clientId: "1234-abc.apps.googleusercontent.com" }, deps),
    ).toMatchObject({
      ok: false,
      field: "clientSecret",
    });
    expect(
      await validateGoogleClient(
        { clientId: "1234-abc.apps.googleusercontent.com", clientSecret: "wrong" },
        deps,
      ),
    ).toMatchObject({ ok: false, field: "clientSecret" });
    expect(
      await validateGoogleClient(
        { clientId: "1234-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-secret" },
        deps,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await validateGoogleClient(
        { clientId: "1234-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-secret" },
        { fetch: async () => new Response("down", { status: 503 }) },
      ),
    ).toMatchObject({ ok: false, field: "network" });
  });

  test("Microsoft: tells a bad tenant, an unknown app and a good pair apart", async () => {
    const server = createGraphServer(fixture, { tenant: "contoso" });
    const deps = { fetch: server.fetch };
    expect(await validateMicrosoftClient({ clientId: "nope" }, deps)).toMatchObject({
      ok: false,
      field: "clientId",
    });
    expect(
      await validateMicrosoftClient(
        { clientId: "12345678-1234-1234-1234-123456789abc", tenant: "missing" },
        deps,
      ),
    ).toMatchObject({ ok: false, field: "tenant" });
    expect(
      await validateMicrosoftClient(
        { clientId: "00000000-0000-0000-0000-000000000000", tenant: "contoso" },
        deps,
      ),
    ).toMatchObject({ ok: false, field: "clientId" });
    expect(
      await validateMicrosoftClient(
        { clientId: "12345678-1234-1234-1234-123456789abc", tenant: "contoso" },
        deps,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await validateMicrosoftClient(
        { clientId: "12345678-1234-1234-1234-123456789abc", tenant: "contoso" },
        {
          fetch: async () => {
            throw new Error("offline");
          },
        },
      ),
    ).toMatchObject({ ok: false, field: "network" });
  });
});
