// The token broker: hands adapters a live access token for an OAuthAuth,
// refreshing through the stored client registration when the token is within
// the skew of its expiry (Google tokens last an hour, Entra 60 to 90 minutes).
// Refreshes are deduplicated per refresh token and the updated Auth is
// reported so the credential store can persist it (Entra rotates refresh
// tokens on every use).

import type { FetchLike } from "../jmap/client.ts";
import type { OAuthAuth } from "../types.ts";
import { ProviderError } from "../types.ts";
import { parseTokenResponse, postForm, tokenRequestBody } from "./flow.ts";
import { issuerFor, type OAuthIssuerName, type OAuthPath } from "./issuers.ts";

export interface TokenBroker {
  /**
   * A token good for at least the skew, refreshing when needed. `force`
   * refreshes regardless; `rejected` is the token a server just refused, so a
   * refresh happens only if nobody else already replaced it (concurrent
   * requests that all hit 401 cost one refresh, not one each).
   */
  access(
    auth: OAuthAuth,
    options?: { force?: boolean; rejected?: string; path?: OAuthPath },
  ): Promise<string>;
}

export interface TokenBrokerOptions {
  fetch?: FetchLike;
  now?: () => number;
  /** Refresh this long before expiry. */
  skewMs?: number;
  /** Called with the mutated Auth after every refresh, to persist it. */
  onRefreshed?: (auth: OAuthAuth) => Promise<void>;
}

export const DEFAULT_SKEW_MS = 5 * 60_000;

function issuerNameOf(auth: OAuthAuth): OAuthIssuerName {
  if (auth.issuer === "google" || auth.issuer === "microsoft") return auth.issuer;
  throw new ProviderError(`unknown OAuth issuer ${auth.issuer}`, "unsupported");
}

export function createTokenBroker(options: TokenBrokerOptions = {}): TokenBroker {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const skew = options.skewMs ?? DEFAULT_SKEW_MS;
  const inFlight = new Map<string, Promise<void>>();

  async function refresh(auth: OAuthAuth, path: OAuthPath): Promise<void> {
    if (!auth.refreshToken) {
      throw new ProviderError("no refresh token; sign in again", "auth");
    }
    if (!auth.client) {
      throw new ProviderError("no OAuth client stored; sign in again", "auth");
    }
    const issuer = issuerFor(issuerNameOf(auth), path, auth.client.tenant);
    const response = await postForm(
      fetchImpl,
      issuer.tokenEndpoint,
      tokenRequestBody(issuer, auth.client, {
        grant_type: "refresh_token",
        refresh_token: auth.refreshToken,
        // Entra wants the scope repeated to get a token for the same resource.
        ...(issuer.name === "microsoft" ? { scope: issuer.scopes.join(" ") } : {}),
      }),
    );
    const tokens = await parseTokenResponse(response, now(), auth.refreshToken);
    auth.accessToken = tokens.accessToken;
    auth.expiresAt = new Date(tokens.expiresAt).toISOString();
    if (tokens.refreshToken) auth.refreshToken = tokens.refreshToken;
    await options.onRefreshed?.(auth);
  }

  return {
    async access(auth, opts = {}) {
      const expiresAt = auth.expiresAt ? Date.parse(auth.expiresAt) : Number.POSITIVE_INFINITY;
      if (opts.rejected !== undefined && opts.rejected !== auth.accessToken)
        return auth.accessToken;
      const stale =
        opts.force ||
        opts.rejected !== undefined ||
        Number.isNaN(expiresAt) ||
        expiresAt - skew <= now();
      if (!stale) return auth.accessToken;
      const key = auth.refreshToken ?? auth.accessToken;
      let pending = inFlight.get(key);
      if (!pending) {
        pending = refresh(auth, opts.path ?? "api").finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      await pending;
      return auth.accessToken;
    },
  };
}

/** A broker for tests and adapters used without OAuth: returns the stored token untouched. */
export function staticTokenBroker(): TokenBroker {
  return { access: async (auth) => auth.accessToken };
}
