// The authorization code flow with PKCE, for the wizard (ADR 0008): start()
// mints a state and a verifier and builds the authorization URL; finish()
// exchanges the code at the token endpoint with the verifier and returns the
// tokens plus the address they belong to. Pending starts live in memory with
// a short lifetime; the exchange is the only network call.

import type { FetchLike } from "../jmap/client.ts";
import type { OAuthAuth, OAuthClient } from "../types.ts";
import { ProviderError } from "../types.ts";
import { type IssuerConfig, issuerFor, type OAuthIssuerName, type OAuthPath } from "./issuers.ts";
import { challengeOf, generateVerifier, randomState } from "./pkce.ts";
import { fetchAddress } from "./profile.ts";

export interface StartInput {
  provider: OAuthIssuerName;
  client: OAuthClient;
  path: OAuthPath;
  redirectUri: string;
  /** Gmail only: the Pub/Sub topic to watch through, carried to the finished credentials. */
  pubsubTopic?: string | null;
}

export interface Started {
  state: string;
  url: string;
  redirectUri: string;
}

export interface Pending extends StartInput {
  state: string;
  verifier: string;
  createdAt: number;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope: string | null;
}

export interface Finished {
  provider: OAuthIssuerName;
  path: OAuthPath;
  address: string;
  auth: OAuthAuth;
  pubsubTopic: string | null;
}

export interface OAuthFlowOptions {
  fetch?: FetchLike;
  now?: () => number;
  /** How long a started flow waits for its code. */
  ttlMs?: number;
}

export interface OAuthFlow {
  start(input: StartInput): Promise<Started>;
  finish(state: string, code: string): Promise<Finished>;
  pending(state: string): Pending | null;
  forget(state: string): void;
}

export const DEFAULT_FLOW_TTL_MS = 15 * 60_000;

/** Turns a token endpoint's JSON into a TokenSet, or throws a typed error. */
export async function parseTokenResponse(
  response: Response,
  now: number,
  previousRefreshToken: string | null,
): Promise<TokenSet> {
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!response.ok || typeof body.access_token !== "string") {
    const error = String(body.error ?? response.status);
    const description = typeof body.error_description === "string" ? body.error_description : "";
    throw new ProviderError(
      `token endpoint: ${error}${description ? ` (${description})` : ""}`,
      error === "invalid_grant" || error === "invalid_client" ? "auth" : "protocol",
    );
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === "string" ? body.refresh_token : previousRefreshToken,
    expiresAt: now + expiresIn * 1000,
    scope: typeof body.scope === "string" ? body.scope : null,
  };
}

export function tokenRequestBody(
  issuer: IssuerConfig,
  client: OAuthClient,
  grant: Record<string, string>,
): URLSearchParams {
  const params = new URLSearchParams({ client_id: client.id, ...grant });
  if (issuer.usesClientSecret && client.secret) params.set("client_secret", client.secret);
  return params;
}

export async function postForm(
  fetchImpl: FetchLike,
  url: string,
  params: URLSearchParams,
): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: params.toString(),
  });
}

export function authorizationUrl(
  issuer: IssuerConfig,
  input: StartInput,
  state: string,
  challenge: string,
): string {
  const url = new URL(issuer.authorizationEndpoint);
  url.searchParams.set("client_id", input.client.id);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", issuer.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [k, v] of Object.entries(issuer.authorizationParams)) url.searchParams.set(k, v);
  return url.toString();
}

export function createOAuthFlow(options: OAuthFlowOptions = {}): OAuthFlow {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const ttl = options.ttlMs ?? DEFAULT_FLOW_TTL_MS;
  const pending = new Map<string, Pending>();

  function sweep(): void {
    const cutoff = now() - ttl;
    for (const [state, p] of pending) if (p.createdAt < cutoff) pending.delete(state);
  }

  return {
    async start(input) {
      sweep();
      if (!input.client.id.trim()) throw new ProviderError("client id is empty", "auth");
      const issuer = issuerFor(input.provider, input.path, input.client.tenant);
      const state = randomState();
      const verifier = generateVerifier();
      const challenge = await challengeOf(verifier);
      pending.set(state, { ...input, state, verifier, createdAt: now() });
      return {
        state,
        url: authorizationUrl(issuer, input, state, challenge),
        redirectUri: input.redirectUri,
      };
    },

    async finish(state, code) {
      sweep();
      const p = pending.get(state);
      if (!p) throw new ProviderError("unknown or expired OAuth state", "auth");
      pending.delete(state);
      const issuer = issuerFor(p.provider, p.path, p.client.tenant);
      const response = await postForm(
        fetchImpl,
        issuer.tokenEndpoint,
        tokenRequestBody(issuer, p.client, {
          grant_type: "authorization_code",
          code,
          code_verifier: p.verifier,
          redirect_uri: p.redirectUri,
        }),
      );
      const tokens = await parseTokenResponse(response, now(), null);
      const address = await fetchAddress(p.provider, p.path, tokens.accessToken, fetchImpl);
      const auth: OAuthAuth = {
        kind: "oauth",
        user: address,
        issuer: p.provider,
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        expiresAt: new Date(tokens.expiresAt).toISOString(),
        client: p.client,
      };
      return {
        provider: p.provider,
        path: p.path,
        address,
        auth,
        pubsubTopic: p.pubsubTopic ?? null,
      };
    },

    pending(state) {
      sweep();
      return pending.get(state) ?? null;
    },

    forget(state) {
      pending.delete(state);
    },
  };
}
