// The auth layer both IMAP and SMTP share: plain password (app passwords at
// Fastmail, iCloud, Yahoo, Dovecot) or XOAUTH2 (Gmail and Microsoft, wired by
// slice 9). The SASL strings are here so tests can check them without a
// socket; imapflow and nodemailer do the actual exchange.

import type { Auth } from "../types.ts";
import { ProviderError } from "../types.ts";

/** The XOAUTH2 initial client response before base64 (Google and Microsoft, not an RFC). */
export function xoauth2String(user: string, accessToken: string): string {
  return `user=${user}\x01auth=Bearer ${accessToken}\x01\x01`;
}

export interface ImapAuthOptions {
  user: string;
  pass?: string;
  accessToken?: string;
}

export function imapAuthOf(auth: Auth): ImapAuthOptions {
  switch (auth.kind) {
    case "password":
      return { user: auth.user, pass: auth.password };
    case "oauth":
      return { user: auth.user, accessToken: auth.accessToken };
    case "token":
      throw new ProviderError("IMAP needs a password or an OAuth token", "auth");
  }
}

export type SmtpAuthOptions =
  | { user: string; pass: string }
  | { type: "OAuth2"; user: string; accessToken: string };

export function smtpAuthOf(auth: Auth): SmtpAuthOptions {
  switch (auth.kind) {
    case "password":
      return { user: auth.user, pass: auth.password };
    case "oauth":
      return { type: "OAuth2", user: auth.user, accessToken: auth.accessToken };
    case "token":
      throw new ProviderError("SMTP needs a password or an OAuth token", "auth");
  }
}

/** Which OAuth issuer an IMAP host belongs to, when its capabilities demand XOAUTH2. */
export function oauthIssuerOfHost(host: string): "google" | "microsoft" | null {
  const h = host.toLowerCase();
  if (/(^|\.)(gmail\.com|googlemail\.com|google\.com)$/.test(h)) return "google";
  if (
    /(^|\.)(office365\.com|outlook\.com|hotmail\.com|live\.com|office\.com|microsoft\.com)$/.test(h)
  ) {
    return "microsoft";
  }
  return null;
}

/** True when the server only takes XOAUTH2: it advertises it and refuses LOGIN. */
export function needsOAuth(capabilities: Iterable<string>): boolean {
  const caps = new Set([...capabilities].map((c) => c.toUpperCase()));
  const hasPlain = caps.has("AUTH=PLAIN") || caps.has("AUTH=LOGIN");
  return caps.has("AUTH=XOAUTH2") && (caps.has("LOGINDISABLED") || !hasPlain);
}
