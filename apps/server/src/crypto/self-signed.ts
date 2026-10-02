// A self-signed certificate for the Sidecar's LAN listener (ADR 0006: "self-
// signed is pinned on first pairing"). An ECDSA P-256 key and an X.509 v3
// certificate built with Web Crypto and a few lines of DER, so the Server
// needs no openssl binary and no certificate library. Nobody trusts it by
// its chain: a phone pins its SHA-256 fingerprint, which travels in the
// pairing QR code.
//
// Runtime-neutral: Web Crypto only.

export interface SelfSignedCertificate {
  /** PEM "CERTIFICATE". */
  certPem: string;
  /** PEM "PRIVATE KEY" (PKCS #8). */
  keyPem: string;
  /** SHA-256 of the certificate's DER, base64url without padding. */
  fingerprint: string;
}

export interface SelfSignedOptions {
  commonName?: string;
  /** DNS names in the subjectAltName extension. */
  dnsNames?: readonly string[];
  /** How long the certificate is valid; ten years by default, since nothing trusts it by date. */
  validDays?: number;
  now?: Date;
}

/* ------------------------------ DER ------------------------------ */

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function length(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function tlv(tag: number, ...content: Uint8Array[]): Uint8Array {
  const body = concat(content);
  return concat([Uint8Array.of(tag), length(body.length), body]);
}

const sequence = (...parts: Uint8Array[]) => tlv(0x30, ...parts);
const set = (...parts: Uint8Array[]) => tlv(0x31, ...parts);
const explicit = (n: number, ...parts: Uint8Array[]) => tlv(0xa0 + n, ...parts);

/** A non-negative INTEGER from big-endian bytes: leading zeros dropped, a 0x00 added when the top bit is set. */
function integer(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const trimmed = bytes.subarray(i);
  const padded = (trimmed[0] ?? 0) & 0x80 ? concat([Uint8Array.of(0), trimmed]) : trimmed;
  return tlv(0x02, padded);
}

function oid(dotted: string): Uint8Array {
  const parts = dotted.split(".").map(Number);
  const [first = 0, second = 0, ...rest] = parts;
  const bytes = [first * 40 + second];
  for (const p of rest) {
    const chunk: number[] = [];
    let v = p;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let k = 0; k < chunk.length - 1; k++) chunk[k] = (chunk[k] ?? 0) | 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(bytes));
}

const utf8 = (text: string) => tlv(0x0c, new TextEncoder().encode(text));
const ia5 = (tag: number, text: string) => tlv(tag, new TextEncoder().encode(text));

/** UTCTime through 2049, GeneralizedTime after (RFC 5280, 4.1.2.5). */
function time(date: Date): Uint8Array {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHMMSS
  const year = date.getUTCFullYear();
  return year < 2050 ? ia5(0x17, `${iso.slice(2)}Z`) : ia5(0x18, `${iso}Z`);
}

function name(commonName: string): Uint8Array {
  return sequence(set(sequence(oid("2.5.4.3"), utf8(commonName))));
}

/** Web Crypto's ECDSA signature is r || s; X.509 wants SEQUENCE { INTEGER r, INTEGER s }. */
function ecdsaDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  return sequence(integer(raw.subarray(0, half)), integer(raw.subarray(half)));
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function pem(label: string, der: Uint8Array): string {
  const lines = base64(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** The DER inside a PEM block; null when there is none. */
export function pemToDer(text: string, label = "CERTIFICATE"): Uint8Array | null {
  const match = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`).exec(text);
  if (!match?.[1]) return null;
  try {
    const binary = atob(match[1].replace(/\s+/g, ""));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** SHA-256 of a certificate's DER, base64url without padding: what a phone pins. */
export async function certificateFingerprint(der: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
  return base64(digest).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/* ------------------------------ Certificate ------------------------------ */

const ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
const BASIC_CONSTRAINTS = "2.5.29.19";
const SUBJECT_ALT_NAME = "2.5.29.17";
const DAY_MS = 86_400_000;

export async function createSelfSignedCertificate(
  options: SelfSignedOptions = {},
): Promise<SelfSignedCertificate> {
  const commonName = options.commonName ?? "monday";
  const dnsNames = options.dnsNames ?? ["monday.local"];
  const now = options.now ?? new Date();
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));

  const serial = new Uint8Array(16);
  crypto.getRandomValues(serial);
  serial[0] = (serial[0] ?? 0) & 0x7f || 0x01;

  const algorithm = sequence(oid(ECDSA_WITH_SHA256));
  const notBefore = new Date(now.getTime() - DAY_MS);
  const notAfter = new Date(now.getTime() + (options.validDays ?? 3650) * DAY_MS);
  const extensions = explicit(
    3,
    sequence(
      // Not a CA: it signs nothing but itself.
      sequence(oid(BASIC_CONSTRAINTS), tlv(0x01, Uint8Array.of(0xff)), tlv(0x04, sequence())),
      sequence(
        oid(SUBJECT_ALT_NAME),
        tlv(0x04, sequence(...dnsNames.map((dns) => ia5(0x82, dns)))),
      ),
    ),
  );
  const tbs = sequence(
    explicit(0, integer(Uint8Array.of(2))),
    integer(serial),
    algorithm,
    name(commonName),
    sequence(time(notBefore), time(notAfter)),
    name(commonName),
    spki,
    extensions,
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, tbs),
  );
  const cert = sequence(tbs, algorithm, tlv(0x03, concat([Uint8Array.of(0), ecdsaDer(signature)])));
  return {
    certPem: pem("CERTIFICATE", cert),
    keyPem: pem("PRIVATE KEY", pkcs8),
    fingerprint: await certificateFingerprint(cert),
  };
}
