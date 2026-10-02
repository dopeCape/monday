import { describe, expect, test } from "bun:test";
import {
  checkServerUrl,
  encodePairingPayload,
  formatInviteCode,
  isPrivateHost,
  normalizeInviteCode,
  type PairingPayload,
  parsePairingPayload,
  shortFingerprint,
} from "./pairing.ts";

const payload: PairingPayload = {
  name: "Tejas's laptop",
  urls: ["https://192.168.1.20:47820", "https://mail.example.com"],
  secret: "s3cr3t-_abc",
  code: "AB12CD34",
  expiresAt: "2026-10-02T12:10:00.000Z",
  fingerprint: "q83vEjRWeJA",
};

describe("pairing payload", () => {
  test("round-trips through the QR text", () => {
    const text = encodePairingPayload(payload);
    expect(text.startsWith("monday://pair?v=1&")).toBe(true);
    expect(parsePairingPayload(text)).toEqual(payload);
  });

  test("plain http survives only for a private address, and no fingerprint reads as null", () => {
    const text = encodePairingPayload({
      ...payload,
      urls: ["http://10.0.2.2:5555", "http://203.0.113.9:47820"],
      fingerprint: null,
    });
    expect(parsePairingPayload(text)).toEqual({
      ...payload,
      urls: ["http://10.0.2.2:5555"],
      fingerprint: null,
    });
  });

  test("anything else is not a pairing code", () => {
    expect(parsePairingPayload("https://example.com")).toBeNull();
    expect(parsePairingPayload("monday://pair?v=2&s=x&c=AB12CD34&e=x&u=https://a")).toBeNull();
    expect(parsePairingPayload("monday://pair?v=1&c=AB12CD34&e=x&u=https://a")).toBeNull();
    expect(parsePairingPayload("monday://pair?v=1&s=x&c=AB12CD34&e=x")).toBeNull();
  });
});

describe("short codes", () => {
  test("normalize case, separators and the letters read as digits", () => {
    expect(normalizeInviteCode("ab12-cd34")).toBe("AB12CD34");
    expect(normalizeInviteCode(" o1il 2345 ")).toBe("01112345");
    expect(normalizeInviteCode("AB12CD3")).toBeNull();
    expect(normalizeInviteCode("AB12CD3U")).toBeNull();
    expect(formatInviteCode("AB12CD34")).toBe("AB12-CD34");
  });

  test("a fingerprint shortens to hex pairs", () => {
    expect(shortFingerprint("q83vEjRWeJA", 3)).toBe("AB:CD:EF");
  });
});

describe("server addresses", () => {
  test("private hosts", () => {
    for (const h of [
      "10.0.2.2",
      "127.0.0.1",
      "192.168.1.4",
      "172.20.0.1",
      "localhost",
      "mac.local",
      "[::1]",
      "fd12:3456::1",
      "fe80::1",
    ]) {
      expect(isPrivateHost(h)).toBe(true);
    }
    for (const h of ["8.8.8.8", "172.32.0.1", "example.com", "2001:db8::1"]) {
      expect(isPrivateHost(h)).toBe(false);
    }
  });

  test("a manually typed address: the emulator's http is fine, public http is not", () => {
    expect(checkServerUrl("http://10.0.2.2:41234/")).toEqual({
      ok: true,
      url: "http://10.0.2.2:41234",
    });
    expect(checkServerUrl("http://localhost:41234")).toEqual({
      ok: true,
      url: "http://localhost:41234",
    });
    expect(checkServerUrl("mail.example.com")).toEqual({
      ok: true,
      url: "https://mail.example.com",
    });
    expect(checkServerUrl("http://mail.example.com")).toEqual({ ok: false, reason: "insecure" });
    expect(checkServerUrl("ftp://x")).toEqual({ ok: false, reason: "invalid" });
    expect(checkServerUrl("  ")).toEqual({ ok: false, reason: "invalid" });
  });
});
