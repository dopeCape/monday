// OAuth 2.1 for the external MCP server (docs/spec/external-mcp.md,
// Interactive): the metadata documents remote MCP clients discover, dynamic
// client registration (RFC 7591), the authorization code flow with PKCE S256
// only and public clients only, refresh tokens that rotate, and revocation.
// A consent page served by the Server names the client, the scope and the
// Workspaces; the owner approves it from an open monday client or by typing
// the page's pairing code into one. The token that comes out is a credential
// with the same scope model as a key, listed in the same place.
//
// Runtime-neutral: Web Crypto and strings only; the routes own the HTTP.

import type { ExternalConsent, ExternalScope } from "@monday/shared";
import { palettes } from "@monday/ui/palettes";
import { randomCode, randomToken } from "../auth/index.ts";
import {
  type CredentialStore,
  mintAccessToken,
  type OAuthClient,
  type OAuthCode,
} from "./credentials.ts";

export const SCOPES: readonly ExternalScope[] = ["read", "act"];

export interface OAuthSettings {
  /** How long an access token lives, in days: the same Setting as a key's expiry. */
  tokenExpiryDays: number;
  /** How long a consent page waits for the owner. */
  consentTtlMs: number;
}

export interface OAuthOptions {
  store: CredentialStore;
  settings(): Promise<OAuthSettings>;
  now?: () => Date;
}

export type OAuthFailure = { ok: false; error: string; description: string; status?: number };

export interface Consent extends ExternalConsent {
  redirectUri: string;
  state: string | null;
}

export type ConsentStatus =
  | { status: "pending" }
  | { status: "approved"; redirect: string }
  | { status: "denied"; redirect: string }
  | { status: "expired" };

export interface IssuedTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: ExternalScope;
}

export interface OAuthServer {
  metadata(issuer: string): Record<string, unknown>;
  resourceMetadata(issuer: string): Record<string, unknown>;
  register(body: unknown): Promise<{ ok: true; client: Record<string, unknown> } | OAuthFailure>;
  /** Validates the authorization request and opens a consent for the owner. */
  authorize(
    query: Record<string, string | undefined>,
  ): Promise<{ ok: true; consent: Consent } | OAuthFailure>;
  consent(id: string): Promise<Consent | null>;
  status(id: string): Promise<ConsentStatus>;
  /** Consents waiting for the owner, for the client's list. */
  listConsents(): Promise<ExternalConsent[]>;
  /** The owner said yes, from a client (by id) or by the page's pairing code. */
  approve(
    ref: { id: string } | { code: string },
    workspaceIds?: string[] | null,
  ): Promise<Consent | null>;
  deny(id: string): Promise<boolean>;
  token(
    form: Record<string, string | undefined>,
  ): Promise<{ ok: true; tokens: IssuedTokens } | OAuthFailure>;
  /** Revokes the credential an access or refresh token names; silent when unknown (RFC 7009). */
  revoke(token: string): Promise<void>;
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return base64url(new Uint8Array(digest));
}

const fail = (error: string, description: string, status = 400): OAuthFailure => ({
  ok: false,
  error,
  description,
  status,
});

function parseScope(raw: string | undefined): ExternalScope | null {
  const parts = (raw ?? "read").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "read";
  if (parts.every((p) => p === "read")) return "read";
  if (parts.every((p) => p === "read" || p === "act")) return "act";
  return null;
}

/** A redirect URI a public client may register: https, or http on loopback (RFC 8252). */
export function redirectUriAllowed(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  }
  // A custom scheme (a desktop client's callback) is allowed as well.
  return /^[a-z][a-z0-9+.-]*:$/i.test(url.protocol) && url.protocol !== "javascript:";
}

function redirectWith(uri: string, params: Record<string, string | null>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  return url.toString();
}

export function createOAuthServer(options: OAuthOptions): OAuthServer {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  /** The authorization code in clear, until the consent page reads it once. */
  const issued = new Map<string, string>();
  const denied = new Set<string>();

  const consentOf = (code: OAuthCode, client: OAuthClient): Consent => ({
    id: code.id,
    clientId: client.id,
    clientName: client.name,
    scope: code.scope,
    workspaceIds: code.workspaceIds,
    code: code.pairingCode,
    expiresAt: code.expiresAt,
    redirectUri: code.redirectUri,
    state: code.state,
  });

  const api: OAuthServer = {
    metadata(issuer) {
      return {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        revocation_endpoint: `${issuer}/oauth/revoke`,
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [...SCOPES],
      };
    },

    resourceMetadata(issuer) {
      return {
        resource: `${issuer}/mcp`,
        authorization_servers: [issuer],
        bearer_methods_supported: ["header"],
        scopes_supported: [...SCOPES],
        resource_name: "monday",
      };
    },

    async register(body) {
      if (!body || typeof body !== "object") {
        return fail("invalid_client_metadata", "The registration must be a JSON object.");
      }
      const meta = body as Record<string, unknown>;
      const uris = Array.isArray(meta.redirect_uris)
        ? meta.redirect_uris.filter((u): u is string => typeof u === "string")
        : [];
      if (uris.length === 0) {
        return fail("invalid_redirect_uri", "redirect_uris must list at least one URI.");
      }
      const bad = uris.find((u) => !redirectUriAllowed(u));
      if (bad) {
        return fail("invalid_redirect_uri", `${bad} is not https, loopback or a custom scheme.`);
      }
      const method = meta.token_endpoint_auth_method;
      if (method !== undefined && method !== "none") {
        return fail(
          "invalid_client_metadata",
          "Only public clients with PKCE are supported: token_endpoint_auth_method must be none.",
        );
      }
      const grants = Array.isArray(meta.grant_types) ? meta.grant_types : ["authorization_code"];
      const unknownGrant = grants.find((g) => g !== "authorization_code" && g !== "refresh_token");
      if (unknownGrant) {
        return fail(
          "invalid_client_metadata",
          `Grant type ${String(unknownGrant)} is not supported.`,
        );
      }
      const name =
        typeof meta.client_name === "string" && meta.client_name.trim()
          ? meta.client_name.trim().slice(0, 80)
          : new URL(uris[0] as string).hostname || "MCP client";
      const client = await store.registerClient({
        id: randomToken(16),
        name,
        redirectUris: uris,
        metadata: meta,
      });
      return {
        ok: true,
        client: {
          ...meta,
          client_id: client.id,
          client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
          client_name: client.name,
          redirect_uris: client.redirectUris,
          token_endpoint_auth_method: "none",
          grant_types: grants,
          response_types: ["code"],
        },
      };
    },

    async authorize(q) {
      const client = q.client_id ? await store.getClient(q.client_id) : null;
      if (!client) return fail("invalid_client", "Unknown client_id.", 400);
      const redirectUri = q.redirect_uri ?? client.redirectUris[0];
      if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
        return fail("invalid_request", "redirect_uri is not one the client registered.");
      }
      if (q.response_type !== "code") {
        return fail("unsupported_response_type", "Only response_type=code is supported.");
      }
      if (!q.code_challenge || q.code_challenge_method !== "S256") {
        return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
      }
      const scope = parseScope(q.scope);
      if (!scope) return fail("invalid_scope", "Scope must be read or act.");
      const settings = await options.settings();
      const code = await store.createCode({
        clientId: client.id,
        pairingCode: randomCode(),
        redirectUri,
        scope,
        workspaceIds: null,
        state: q.state ?? null,
        codeChallenge: q.code_challenge,
        resource: q.resource ?? null,
        expiresAt: new Date(now().getTime() + settings.consentTtlMs),
      });
      return { ok: true, consent: consentOf(code, client) };
    },

    async consent(id) {
      const code = await store.getCode(id);
      if (!code) return null;
      const client = await store.getClient(code.clientId);
      return client ? consentOf(code, client) : null;
    },

    async status(id) {
      const code = await store.getCode(id);
      if (!code) return { status: "expired" };
      if (denied.has(id) || (code.usedAt && !code.approvedAt)) {
        return {
          status: "denied",
          redirect: redirectWith(code.redirectUri, {
            error: "access_denied",
            error_description: "The owner declined.",
            state: code.state,
          }),
        };
      }
      if (code.approvedAt) {
        const clear = issued.get(id);
        if (!clear) return { status: "expired" };
        issued.delete(id);
        return {
          status: "approved",
          redirect: redirectWith(code.redirectUri, { code: clear, state: code.state }),
        };
      }
      if (Date.parse(code.expiresAt) <= now().getTime()) return { status: "expired" };
      return { status: "pending" };
    },

    async listConsents() {
      const open = await store.listOpenCodes();
      const out: ExternalConsent[] = [];
      for (const code of open) {
        const client = await store.getClient(code.clientId);
        if (!client) continue;
        const { redirectUri: _r, state: _s, ...consent } = consentOf(code, client);
        out.push(consent);
      }
      return out;
    },

    async approve(ref, workspaceIds = null) {
      const open =
        "id" in ref ? await store.getCode(ref.id) : await store.findCodeByPairingCode(ref.code);
      if (!open || open.approvedAt || open.usedAt) return null;
      if (Date.parse(open.expiresAt) <= now().getTime()) return null;
      const clear = randomToken(32);
      const approved = await store.approveCode(open.id, clear, workspaceIds);
      if (!approved) return null;
      issued.set(approved.id, clear);
      const client = await store.getClient(approved.clientId);
      return client ? consentOf(approved, client) : null;
    },

    async deny(id) {
      const code = await store.getCode(id);
      if (!code || code.usedAt) return false;
      await store.denyCode(id);
      denied.add(id);
      return true;
    },

    async token(form) {
      const settings = await options.settings();
      const expiresAt = new Date(now().getTime() + settings.tokenExpiryDays * 86_400_000);
      const expiresIn = Math.floor((expiresAt.getTime() - now().getTime()) / 1000);
      const mint = async (credentialId: string, scope: ExternalScope): Promise<IssuedTokens> => {
        const access = mintAccessToken();
        await store.rotateSecret(credentialId, access, expiresAt);
        const refresh = randomToken(32);
        await store.insertRefresh(credentialId, refresh);
        return {
          access_token: access,
          token_type: "Bearer",
          expires_in: expiresIn,
          refresh_token: refresh,
          scope,
        };
      };

      if (form.grant_type === "authorization_code") {
        if (!form.code || !form.code_verifier) {
          return fail("invalid_request", "code and code_verifier are required.");
        }
        const code = await store.consumeCode(form.code);
        if (!code?.approvedAt) return fail("invalid_grant", "Unknown or spent code.");
        if (Date.parse(code.expiresAt) <= now().getTime()) {
          return fail("invalid_grant", "The code expired.");
        }
        if (form.client_id && form.client_id !== code.clientId) {
          return fail("invalid_grant", "The code belongs to another client.");
        }
        if (form.redirect_uri && form.redirect_uri !== code.redirectUri) {
          return fail("invalid_grant", "redirect_uri does not match the authorization.");
        }
        if ((await pkceChallenge(form.code_verifier)) !== code.codeChallenge) {
          return fail("invalid_grant", "The PKCE verifier does not match.");
        }
        const client = await store.getClient(code.clientId);
        if (!client) return fail("invalid_client", "The client is gone.");
        const credential = await store.insert({
          kind: "oauth",
          name: client.name,
          scope: code.scope,
          workspaceIds: code.workspaceIds,
          secret: mintAccessToken(),
          expiresAt,
          clientId: client.id,
        });
        return { ok: true, tokens: await mint(credential.id, credential.scope) };
      }

      if (form.grant_type === "refresh_token") {
        if (!form.refresh_token) return fail("invalid_request", "refresh_token is required.");
        const credentialId = await store.consumeRefresh(form.refresh_token);
        if (!credentialId) return fail("invalid_grant", "Unknown or spent refresh token.");
        const credential = await store.get(credentialId);
        if (!credential || credential.revokedAt) {
          return fail("invalid_grant", "The credential was revoked.");
        }
        if (form.client_id && credential.clientId !== form.client_id) {
          return fail("invalid_grant", "The token belongs to another client.");
        }
        return { ok: true, tokens: await mint(credential.id, credential.scope) };
      }

      return fail("unsupported_grant_type", "Use authorization_code or refresh_token.");
    },

    async revoke(token) {
      const credential = await store.findBySecret(token);
      if (credential) {
        await store.revoke(credential.id);
        return;
      }
      const credentialId = await store.consumeRefresh(token);
      if (credentialId) await store.revoke(credentialId);
    },
  };
  return api;
}

/* ------------------------------ The consent page ------------------------------ */

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export interface ConsentPageInput {
  consent: Consent;
  /** The Workspaces the token would reach, by address, when the Server can name them. */
  workspaces: Array<{ id: string; address: string }>;
  /** Where the page polls its status and posts a denial. */
  statusUrl: string;
  denyUrl: string;
  strings: {
    title: string;
    intro: string;
    scopeRead: string;
    scopeAct: string;
    codeHint: string;
    waiting: string;
    deny: string;
    approved: string;
    denied: string;
    expired: string;
  };
}

/** Plain HTML on the graphite palette from packages/ui, light and dark. */
export function consentPage(input: ConsentPageInput): string {
  const graphite = palettes.find((p) => p.key === "graphite") ?? palettes[0];
  if (!graphite) throw new Error("no palette");
  const { consent, strings } = input;
  const scopeLine = consent.scope === "read" ? strings.scopeRead : strings.scopeAct;
  const workspaceLine =
    input.workspaces.length === 0
      ? "every Workspace"
      : input.workspaces.map((w) => escapeHtml(w.address)).join(", ");
  const css = `
:root{--bg:${graphite.light.bg};--panel:${graphite.light.panel};--fg:${graphite.light.fg};--accent:${graphite.light.accent};--border:${graphite.light.border}}
@media (prefers-color-scheme: dark){:root{--bg:${graphite.dark.bg};--panel:${graphite.dark.panel};--fg:${graphite.dark.fg};--accent:${graphite.dark.accent};--border:${graphite.dark.border}}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
main{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:28px;max-width:440px;width:100%}
h1{font-size:18px;margin:0 0 8px}p{margin:0 0 12px;opacity:.85}dl{margin:0 0 16px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px}dt{opacity:.6}dd{margin:0}
.code{font:600 32px/1 ui-monospace,Menlo,monospace;letter-spacing:.2em;text-align:center;padding:16px;border:1px dashed var(--border);border-radius:8px;margin:0 0 8px}
button{font:inherit;border:1px solid var(--border);background:transparent;color:var(--fg);border-radius:8px;padding:8px 14px;cursor:pointer}
.status{margin-top:12px;color:var(--accent)}`;
  const script = `
(function(){var s=document.getElementById('status');function poll(){fetch(${JSON.stringify(input.statusUrl)},{headers:{accept:'application/json'}}).then(function(r){return r.json()}).then(function(j){if(j.status==='approved'){s.textContent=${JSON.stringify(strings.approved)};location.replace(j.redirect)}else if(j.status==='denied'){s.textContent=${JSON.stringify(strings.denied)};location.replace(j.redirect)}else if(j.status==='expired'){s.textContent=${JSON.stringify(strings.expired)}}else{setTimeout(poll,2000)}}).catch(function(){setTimeout(poll,4000)})}poll();
var d=document.getElementById('deny');if(d){d.addEventListener('click',function(){fetch(${JSON.stringify(input.denyUrl)},{method:'POST'}).then(poll)})}})();`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(strings.title)}</title><style>${css}</style></head>
<body><main>
<h1>${escapeHtml(strings.title)}</h1>
<p>${escapeHtml(strings.intro.replace("{client}", consent.clientName))}</p>
<dl><dt>Client</dt><dd>${escapeHtml(consent.clientName)}</dd><dt>Scope</dt><dd>${escapeHtml(scopeLine)}</dd><dt>Workspaces</dt><dd>${workspaceLine}</dd></dl>
<div class="code">${escapeHtml(consent.code)}</div>
<p>${escapeHtml(strings.codeHint)}</p>
<button id="deny" type="button">${escapeHtml(strings.deny)}</button>
<div class="status" id="status">${escapeHtml(strings.waiting)}</div>
</main><script>${script}</script></body></html>`;
}
