// SMTP submission (RFC 6409, RFC 8314): implicit TLS on 465 or STARTTLS on
// 587, AUTH PLAIN or XOAUTH2, via nodemailer. The envelope comes from the
// message headers unless the caller supplies recipients; a Bcc header never
// leaves the machine.

import nodemailer, { type Transporter } from "nodemailer";
import { parseMime, peopleOf } from "../mime.ts";
import type { Auth, HostPort } from "../types.ts";
import { ProviderError } from "../types.ts";
import { smtpAuthOf } from "./auth.ts";

export interface SmtpSender {
  send(mime: Uint8Array, to?: string[]): Promise<{ accepted: string[] }>;
  close(): void;
}

export interface SmtpOptions {
  /** Injected for tests; defaults to nodemailer's SMTP transport. */
  createTransport?: (options: Record<string, unknown>) => Transporter;
}

/** Strips a Bcc header (folded lines included) from the header block. */
export function stripBcc(mime: Uint8Array): Uint8Array {
  const text = new TextDecoder("latin1").decode(mime);
  const end = text.search(/\r?\n\r?\n/);
  if (end < 0) return mime;
  const headers = text.slice(0, end);
  const stripped = headers.replace(/^bcc:.*(?:\r?\n[ \t].*)*\r?\n?/gim, "");
  if (stripped === headers) return mime;
  return new Uint8Array(Buffer.from(stripped + text.slice(end), "latin1"));
}

export async function envelopeOf(
  mime: Uint8Array,
  fallbackFrom: string,
): Promise<{ from: string; to: string[] }> {
  const parsed = await parseMime(mime);
  const from = parsed.from && !parsed.from.group ? parsed.from.address : null;
  const to = [...peopleOf(parsed.to), ...peopleOf(parsed.cc), ...peopleOf(parsed.bcc)]
    .map((p) => p.email)
    .filter((e) => e.length > 0);
  return { from: from || fallbackFrom, to: [...new Set(to)] };
}

export function createSmtpSender(
  endpoint: HostPort,
  auth: Auth,
  address: string,
  options: SmtpOptions = {},
): SmtpSender {
  const create = options.createTransport ?? ((o) => nodemailer.createTransport(o));
  const transport = create({
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.tls === "tls",
    requireTLS: endpoint.tls === "starttls",
    ignoreTLS: endpoint.tls === "none",
    auth: smtpAuthOf(auth),
    connectionTimeout: 30_000,
  });
  return {
    async send(mime, to) {
      const envelope = await envelopeOf(mime, address);
      const rcpt = to && to.length > 0 ? to : envelope.to;
      if (rcpt.length === 0) throw new ProviderError("no recipients", "protocol");
      try {
        const info = await transport.sendMail({
          envelope: { from: envelope.from, to: rcpt },
          raw: Buffer.from(stripBcc(mime)),
        });
        return { accepted: (info.accepted ?? []).map(String) };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const code = (cause as { responseCode?: number }).responseCode;
        if (code === 535 || code === 534) throw new ProviderError(message, "auth", { cause });
        if (code === 552) throw new ProviderError(message, "too-large", { cause });
        if (code === 421 || code === 450 || code === 451) {
          throw new ProviderError(message, "rate-limit", { cause });
        }
        throw new ProviderError(message, "network", { cause });
      }
    },
    close() {
      transport.close();
    },
  };
}
