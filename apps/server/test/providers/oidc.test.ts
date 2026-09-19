// The Pub/Sub OIDC token check on the Gmail webhook (gmail/oidc.ts): every
// claim that must hold, the signature, and the key set's refresh on rotation.

import { describe, expect, test } from "bun:test";
import {
  createGoogleJwks,
  GOOGLE_JWKS_URL,
  verifyGoogleIdToken,
} from "../../src/providers/gmail/oidc.ts";
import { createOidcSigner, googlePushClaims } from "./oidc-signer.ts";

const AUDIENCE = "https://monday.example/webhooks/gmail/acct-1";
const EMAIL = "monday-push@project.iam.gserviceaccount.com";
const AT = Date.parse("2026-09-20T10:00:00Z");
const now = () => AT;

describe("verifyGoogleIdToken", () => {
  test("accepts a token Google signed for this endpoint and account", async () => {
    const signer = await createOidcSigner();
    const token = await signer.sign(googlePushClaims(AUDIENCE, EMAIL, AT));
    const verdict = await verifyGoogleIdToken(
      token,
      { audience: AUDIENCE, email: EMAIL },
      signer.jwks,
      now,
    );
    expect(verdict).toEqual({ ok: true, email: EMAIL, subject: "1234567890" });
    // The email comparison is case-insensitive, the issuer may be the bare host, aud may be a list.
    const variant = await signer.sign(
      googlePushClaims(AUDIENCE, EMAIL.toUpperCase(), AT, {
        iss: "accounts.google.com",
        aud: ["other", AUDIENCE],
      }),
    );
    expect(
      (await verifyGoogleIdToken(variant, { audience: AUDIENCE, email: EMAIL }, signer.jwks, now))
        .ok,
    ).toBe(true);
  });

  test("refuses every token that is not exactly that", async () => {
    const signer = await createOidcSigner();
    const other = await createOidcSigner("other-key");
    const expected = { audience: AUDIENCE, email: EMAIL };
    const check = async (token: string) =>
      (await verifyGoogleIdToken(token, expected, signer.jwks, now)) as {
        ok: false;
        reason: string;
      };

    expect((await check("not.a.jwt.at.all")).reason).toBe("malformed");
    expect((await check("nope")).reason).toBe("malformed");
    expect((await check("")).reason).toBe("malformed");
    // Signed by a key Google does not publish.
    expect((await check(await other.sign(googlePushClaims(AUDIENCE, EMAIL, AT)))).reason).toBe(
      "unknown_key",
    );
    // Signed by an unpublished key that claims a known kid: the signature fails.
    expect(
      (await check(await other.sign(googlePushClaims(AUDIENCE, EMAIL, AT), { kid: signer.kid })))
        .reason,
    ).toBe("bad_signature");
    // Tampered payload.
    const good = await signer.sign(googlePushClaims(AUDIENCE, EMAIL, AT));
    const [h, , s] = good.split(".") as [string, string, string];
    const forged = btoa(JSON.stringify(googlePushClaims(AUDIENCE, "evil@x.test", AT)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect((await check(`${h}.${forged}.${s}`)).reason).toBe("bad_signature");
    // alg none and HS256 are not RS256.
    expect(
      (await check(await signer.sign(googlePushClaims(AUDIENCE, EMAIL, AT), { alg: "none" })))
        .reason,
    ).toBe("unsupported_alg");
    // Wrong issuer, audience, email, unverified email.
    expect(
      (
        await check(
          await signer.sign(googlePushClaims(AUDIENCE, EMAIL, AT, { iss: "https://evil.test" })),
        )
      ).reason,
    ).toBe("issuer");
    expect(
      (await check(await signer.sign(googlePushClaims("https://elsewhere.test/hook", EMAIL, AT))))
        .reason,
    ).toBe("audience");
    expect(
      (await check(await signer.sign(googlePushClaims(AUDIENCE, "someone-else@x.test", AT))))
        .reason,
    ).toBe("email");
    expect(
      (
        await check(
          await signer.sign(googlePushClaims(AUDIENCE, EMAIL, AT, { email_verified: false })),
        )
      ).reason,
    ).toBe("email");
    // Expired, and from the future beyond the skew.
    expect(
      (await check(await signer.sign(googlePushClaims(AUDIENCE, EMAIL, AT - 2 * 3_600_000))))
        .reason,
    ).toBe("expired");
    expect(
      (await check(await signer.sign(googlePushClaims(AUDIENCE, EMAIL, AT + 10 * 60_000)))).reason,
    ).toBe("not_yet_valid");
    // Within the skew is fine.
    expect(
      (
        await verifyGoogleIdToken(
          await signer.sign(googlePushClaims(AUDIENCE, EMAIL, AT + 30_000)),
          expected,
          signer.jwks,
          now,
        )
      ).ok,
    ).toBe(true);
  });
});

describe("the Google key set", () => {
  test("fetches once, honours max-age, and refreshes for a key it has not seen", async () => {
    const first = await createOidcSigner("k1");
    const second = await createOidcSigner("k2");
    let document = first.document();
    let fetches = 0;
    let clock = AT;
    const fetchStub = (async (input: string | URL | Request) => {
      expect(String(input)).toBe(GOOGLE_JWKS_URL);
      fetches += 1;
      return new Response(JSON.stringify(document), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=600" },
      });
    }) as typeof fetch;
    const jwks = createGoogleJwks({ fetch: fetchStub, now: () => clock });
    expect((await jwks.keyFor("k1"))?.kid).toBe("k1");
    expect((await jwks.keyFor("k1"))?.kid).toBe("k1");
    expect(fetches).toBe(1);
    // Past max-age, the next lookup refreshes.
    clock += 601_000;
    expect((await jwks.keyFor("k1"))?.kid).toBe("k1");
    expect(fetches).toBe(2);
    // Rotation: an unknown kid refreshes once and finds the new key.
    document = { keys: [...first.document().keys, ...second.document().keys] };
    expect((await jwks.keyFor("k2"))?.kid).toBe("k2");
    expect(fetches).toBe(3);
    // Still unknown after a refresh: null, one more fetch, no loop.
    expect(await jwks.keyFor("k3")).toBeNull();
    expect(fetches).toBe(4);
  });
});
