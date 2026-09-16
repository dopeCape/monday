// The two OAuth issuers monday talks to and what each path asks for
// (docs/research/provider-sync.md, "Credentials and verification burden").
// Google: a Desktop client with PKCE and a loopback redirect; the API path
// takes gmail.modify plus pubsub, the IMAP path the restricted mail.google.com
// scope. Entra: a public client on the "Mobile and desktop" platform with the
// http://localhost redirect; single tenant or the consumers endpoint.

export type OAuthIssuerName = "google" | "microsoft";

/** Whether the tokens are for the REST API or for XOAUTH2 over IMAP and SMTP. */
export type OAuthPath = "api" | "imap";

export interface IssuerConfig {
  name: OAuthIssuerName;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  discoveryUrl: string;
  scopes: string[];
  /** Extra authorization parameters the issuer wants for a refresh token. */
  authorizationParams: Record<string, string>;
  /** Whether the token endpoint takes the client secret (Google Desktop clients do). */
  usesClientSecret: boolean;
}

export const GOOGLE_DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration";
export const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const GOOGLE_SCOPES: Record<OAuthPath, string[]> = {
  api: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/pubsub"],
  imap: ["https://mail.google.com/"],
};

export const MICROSOFT_LOGIN_BASE = "https://login.microsoftonline.com";

export const MICROSOFT_SCOPES: Record<OAuthPath, string[]> = {
  api: [
    "Mail.ReadWrite",
    "Mail.Send",
    "MailboxSettings.Read",
    "Calendars.ReadWrite",
    "User.Read",
    "offline_access",
  ],
  imap: [
    "https://outlook.office.com/IMAP.AccessAsUser.All",
    "https://outlook.office.com/SMTP.Send",
    "User.Read",
    "offline_access",
  ],
};

export function googleIssuer(path: OAuthPath): IssuerConfig {
  return {
    name: "google",
    authorizationEndpoint: GOOGLE_AUTHORIZATION_URL,
    tokenEndpoint: GOOGLE_TOKEN_URL,
    discoveryUrl: GOOGLE_DISCOVERY_URL,
    scopes: GOOGLE_SCOPES[path],
    // offline for a refresh token; consent so a re-run of the wizard gets a new one.
    authorizationParams: { access_type: "offline", prompt: "consent" },
    usesClientSecret: true,
  };
}

/** Normalizes what the wizard collected: a tenant id, "consumers", "organizations" or "common". */
export function normalizeTenant(tenant: string | undefined | null): string {
  const t = (tenant ?? "").trim();
  return t === "" ? "common" : t;
}

export function microsoftDiscoveryUrl(tenant: string): string {
  return `${MICROSOFT_LOGIN_BASE}/${encodeURIComponent(normalizeTenant(tenant))}/v2.0/.well-known/openid-configuration`;
}

export function microsoftIssuer(path: OAuthPath, tenant: string | undefined | null): IssuerConfig {
  const t = encodeURIComponent(normalizeTenant(tenant));
  return {
    name: "microsoft",
    authorizationEndpoint: `${MICROSOFT_LOGIN_BASE}/${t}/oauth2/v2.0/authorize`,
    tokenEndpoint: `${MICROSOFT_LOGIN_BASE}/${t}/oauth2/v2.0/token`,
    discoveryUrl: microsoftDiscoveryUrl(t),
    scopes: MICROSOFT_SCOPES[path],
    authorizationParams: { prompt: "select_account" },
    usesClientSecret: false,
  };
}

export function issuerFor(
  name: OAuthIssuerName,
  path: OAuthPath,
  tenant?: string | null,
): IssuerConfig {
  return name === "google" ? googleIssuer(path) : microsoftIssuer(path, tenant);
}
