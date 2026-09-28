// Signing in to a remote MCP server (docs/research/mcp-connect.md, the MCP
// authorization spec). The SDK's auth() does the protocol: Protected Resource
// Metadata from the 401, authorization server metadata, Dynamic Client
// Registration, PKCE with S256, the RFC 8707 resource parameter, the code
// exchange and the refresh. This module is the OAuthClientProvider it needs,
// over the sealed store, in two modes:
//   - interactive: one sign-in. The browser goes to the authorization URL, the
//     redirect lands on the Sidecar's loopback listener (RFC 8252) or, on a
//     Cloud server, on its public /mcp-servers/oauth/callback, and finish()
//     exchanges the code. The pending sign-in is sealed with the server, so a
//     Cloud server whose callback runs in another instance can still finish it.
//   - background: every call a Workflow Step or the Agent makes. It sends the
//     stored access token, lets the SDK refresh it on a 401, and never opens a
//     browser: a server that needs the user again reads "needs sign-in".
// The SDK checks neither `state` nor `iss`; finish() does both.

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpOAuthState, McpSecretStore } from "./mcp-secrets.ts";

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** The server needs the user to sign in again; nothing a background call can fix. */
export class McpNeedsSignInError extends Error {
  constructor(readonly server: string) {
    super(`${server} needs you to sign in again`);
    this.name = "McpNeedsSignInError";
  }
}

export interface ProviderOptions {
  store: McpSecretStore;
  name: string;
  clientName: string;
  /** Interactive only: where the browser comes back to for this sign-in. */
  redirectUri?: string;
  /** Interactive only: the sign-in's state, checked on the way back. */
  state?: string;
  /** Interactive only: receives the authorization URL instead of opening anything. */
  onRedirect?: (url: URL) => void;
  /** The Workspace a new sealed row is created under. */
  workspaceId?: string;
}

const FALLBACK_REDIRECT = "http://127.0.0.1/callback";

function redirectsOf(client: OAuthClientInformationMixed | undefined): string[] {
  const uris = (client as { redirect_uris?: unknown } | undefined)?.redirect_uris;
  return Array.isArray(uris) ? uris.filter((u): u is string => typeof u === "string") : [];
}

/**
 * The provider the SDK drives. It reads the sealed row once and keeps it in
 * memory, writing every change straight back, so a call's token lookups do
 * not decrypt per request.
 */
export function createStoredOAuthProvider(
  options: ProviderOptions,
): OAuthClientProvider & { current(): Promise<McpOAuthState> } {
  const interactive = options.redirectUri !== undefined;
  let cached: McpOAuthState | null = null;
  const read = async (): Promise<McpOAuthState> => {
    if (!cached) cached = (await options.store.load(options.name))?.oauth ?? {};
    return cached;
  };
  const write = async (change: (o: McpOAuthState) => McpOAuthState): Promise<void> => {
    const next = await options.store.update(
      options.name,
      (secret) => ({ ...secret, oauth: change(secret.oauth ?? {}) }),
      options.workspaceId,
    );
    cached = next.oauth ?? {};
  };
  let redirect = options.redirectUri ?? FALLBACK_REDIRECT;

  const provider: OAuthClientProvider & { current(): Promise<McpOAuthState> } = {
    current: read,
    get redirectUrl() {
      return redirect;
    },
    get clientMetadata(): OAuthClientMetadata {
      // application_type is from RFC 7591 and asked of native clients by the 2026-07-28 spec.
      return {
        client_name: options.clientName,
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "native",
      } as OAuthClientMetadata;
    },
    ...(options.state ? { state: () => options.state as string } : {}),
    async clientInformation() {
      const o = await read();
      if (!o.client) return undefined;
      // A client registered for another loopback port cannot take this redirect: register again.
      if (interactive) {
        const uris = redirectsOf(o.client);
        if (uris.length > 0 && !uris.includes(redirect)) return undefined;
      } else {
        redirect = redirectsOf(o.client)[0] ?? redirect;
      }
      return o.client;
    },
    async saveClientInformation(client) {
      await write((o) => ({ ...o, client }));
    },
    async tokens() {
      return (await read()).tokens;
    },
    async saveTokens(tokens: OAuthTokens) {
      await write((o) => ({
        ...o,
        tokens,
        tokensAt: new Date().toISOString(),
        error: undefined,
      }));
    },
    async redirectToAuthorization(url) {
      if (!interactive || !options.onRedirect) {
        // A background call found no usable token and no working refresh.
        await write((o) => ({ ...o, error: "sign-in needed" }));
        throw new McpNeedsSignInError(options.name);
      }
      options.onRedirect(url);
    },
    async saveCodeVerifier(codeVerifier) {
      // A background call never starts a sign-in, so it must not clobber one in flight.
      if (!interactive) return;
      await write((o) => ({
        ...o,
        pending: o.pending ? { ...o.pending, codeVerifier } : o.pending,
      }));
    },
    async codeVerifier() {
      const verifier = (await read()).pending?.codeVerifier;
      if (!verifier) throw new Error("no sign-in is waiting for this server");
      return verifier;
    },
    async saveDiscoveryState(state: OAuthDiscoveryState) {
      await write((o) => ({
        ...o,
        discovery: {
          authorizationServerUrl: state.authorizationServerUrl,
          resourceMetadataUrl: state.resourceMetadataUrl,
          authorizationServerMetadata: state.authorizationServerMetadata,
          resourceMetadata: state.resourceMetadata,
        },
      }));
    },
    async discoveryState() {
      const d = (await read()).discovery;
      return d as OAuthDiscoveryState | undefined;
    },
    async invalidateCredentials(scope) {
      await write((o) => ({
        ...o,
        client: scope === "all" || scope === "client" ? undefined : o.client,
        tokens: scope === "all" || scope === "tokens" ? undefined : o.tokens,
        discovery: scope === "all" || scope === "discovery" ? undefined : o.discovery,
        pending:
          scope === "all" || scope === "verifier"
            ? o.pending
              ? { ...o.pending, codeVerifier: null }
              : undefined
            : o.pending,
      }));
    },
  };
  return provider;
}
