// Who the tokens belong to: the address the Account is created under. Gmail's
// profile works under every mail scope, including the IMAP path's
// mail.google.com; Graph's /me needs User.Read, which both paths request.

import type { FetchLike } from "../jmap/client.ts";
import { ProviderError } from "../types.ts";
import type { OAuthIssuerName, OAuthPath } from "./issuers.ts";

export const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
export const GRAPH_ME_URL = "https://graph.microsoft.com/v1.0/me";

export async function fetchAddress(
  provider: OAuthIssuerName,
  _path: OAuthPath,
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const url = provider === "google" ? GMAIL_PROFILE_URL : GRAPH_ME_URL;
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!response.ok) {
    throw new ProviderError(
      `profile lookup failed with ${response.status}`,
      response.status === 401 || response.status === 403 ? "auth" : "protocol",
    );
  }
  const body = (await response.json()) as Record<string, unknown>;
  const address =
    provider === "google"
      ? body.emailAddress
      : typeof body.mail === "string" && body.mail
        ? body.mail
        : body.userPrincipalName;
  if (typeof address !== "string" || !address.includes("@")) {
    throw new ProviderError("profile carries no address", "protocol");
  }
  return address.toLowerCase();
}
