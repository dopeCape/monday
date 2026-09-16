import { describe, expect, test } from "bun:test";
import {
  imapAuthOf,
  needsOAuth,
  oauthIssuerOfHost,
  smtpAuthOf,
  xoauth2String,
} from "../../src/providers/imap/auth.ts";
import {
  folderWithRole,
  roleOfFolder,
  serverSavesSentCopy,
} from "../../src/providers/imap/folders.ts";
import {
  IDLE_REISSUE_MS,
  type IdleConnection,
  idleLoop,
  type Timers,
} from "../../src/providers/imap/idle.ts";
import {
  flagsOfSet,
  hasAttachmentParts,
  parseHeaderBlock,
  summaryOfFetch,
} from "../../src/providers/imap/index.ts";
import { envelopeOf, stripBcc } from "../../src/providers/imap/smtp.ts";
import {
  chooseTier,
  decodeImapState,
  decodeUidSet,
  encodeImapState,
  encodeUidSet,
  messageIdOf,
  parseMessageId,
} from "../../src/providers/imap/tiers.ts";
import { composeMime } from "../../src/providers/mime.ts";
import type { WatchEvent } from "../../src/providers/types.ts";

describe("IMAP sync tiers", () => {
  const caps = (...names: string[]) => new Map(names.map((n) => [n, true as const]));

  test("chosen from what ENABLE accepted, then from CAPABILITY", () => {
    // Fastmail (Cyrus): QRESYNC enabled.
    expect(
      chooseTier(caps("IMAP4REV1", "CONDSTORE", "QRESYNC"), new Set(["QRESYNC", "CONDSTORE"])),
    ).toBe("qresync");
    // Dovecot without QRESYNC enabled but CONDSTORE advertised.
    expect(chooseTier(caps("IMAP4REV1", "CONDSTORE"), new Set())).toBe("condstore");
    // Microsoft 365 and Gmail: neither.
    expect(
      chooseTier(caps("IMAP4", "IMAP4REV1", "AUTH=XOAUTH2", "UIDPLUS", "MOVE", "IDLE"), new Set()),
    ).toBe("full-scan");
    expect(chooseTier(caps("IMAP4REV1", "UNSELECT", "IDLE", "X-GM-EXT-1"), new Set())).toBe(
      "full-scan",
    );
    // Advertised QRESYNC but ENABLE refused it: CONDSTORE still applies.
    expect(chooseTier(caps("QRESYNC", "CONDSTORE"), new Set())).toBe("condstore");
  });

  test("UID sets round trip through sequence-set strings", () => {
    expect(encodeUidSet([1, 2, 3, 5, 7, 8, 9, 12])).toBe("1:3,5,7:9,12");
    expect(encodeUidSet([])).toBe("");
    expect([...decodeUidSet("1:3,5,7:9,12")]).toEqual([1, 2, 3, 5, 7, 8, 9, 12]);
    expect(decodeUidSet("").size).toBe(0);
    const big = Array.from({ length: 50_000 }, (_, i) => i + 1);
    expect(encodeUidSet(big)).toBe("1:50000");
  });

  test("state token round trip and message ids", () => {
    const state = {
      v: 1 as const,
      tier: "qresync" as const,
      uidValidity: "1700000000",
      modseq: "42",
      known: "1:10",
      seen: "1:5",
      flagged: "3",
      complete: true,
    };
    expect(decodeImapState(encodeImapState(state))).toEqual(state);
    expect(decodeImapState("garbage")).toBeNull();
    expect(decodeImapState(null)).toBeNull();
    const id = messageIdOf("Work/Clients:2026", "1700000000", 77);
    expect(parseMessageId(id)).toEqual({
      path: "Work/Clients:2026",
      uidValidity: "1700000000",
      uid: 77,
    });
    expect(() => parseMessageId("nope")).toThrow();
  });
});

describe("IMAP folders", () => {
  const folder = (path: string, flags: string[] = [], specialUse?: string) => ({
    path,
    name: path.split("/").pop() ?? path,
    flags: new Set(flags),
    specialUse,
  });

  test("SPECIAL-USE first, then names", () => {
    expect(roleOfFolder(folder("INBOX"))).toBe("inbox");
    expect(roleOfFolder(folder("Stuff", ["\\Trash"], "\\Trash"))).toBe("trash");
    expect(roleOfFolder(folder("[Gmail]/All Mail", ["\\All"]))).toBe("all");
    expect(roleOfFolder(folder("Sent Items"))).toBe("sent");
    expect(roleOfFolder(folder("Deleted Items"))).toBe("trash");
    expect(roleOfFolder(folder("Junk E-mail"))).toBe("junk");
    expect(roleOfFolder(folder("Projects"))).toBeNull();
  });

  test("a marked folder beats a name match", () => {
    const folders = [folder("Trash"), folder("Deleted", ["\\Trash"], "\\Trash")];
    expect(folderWithRole(folders, "trash")?.path).toBe("Deleted");
    expect(folderWithRole([folder("Bin")], "trash")?.path).toBe("Bin");
    expect(folderWithRole([folder("Bin")], "archive")).toBeNull();
  });

  test("Gmail and Exchange copy sent mail themselves", () => {
    expect(serverSavesSentCopy("smtp.gmail.com")).toBe(true);
    expect(serverSavesSentCopy("smtp.office365.com")).toBe(true);
    expect(serverSavesSentCopy("smtp-mail.outlook.com")).toBe(true);
    expect(serverSavesSentCopy("smtp.fastmail.com")).toBe(false);
    expect(serverSavesSentCopy("mail.example.test")).toBe(false);
  });
});

describe("IMAP auth", () => {
  test("XOAUTH2 initial response", () => {
    expect(xoauth2String("u@example.test", "tok")).toBe(
      "user=u@example.test\x01auth=Bearer tok\x01\x01",
    );
  });

  test("password and OAuth map to imapflow and nodemailer options; API tokens do not fit", () => {
    expect(imapAuthOf({ kind: "password", user: "u", password: "p" })).toEqual({
      user: "u",
      pass: "p",
    });
    expect(imapAuthOf({ kind: "oauth", user: "u", issuer: "google", accessToken: "t" })).toEqual({
      user: "u",
      accessToken: "t",
    });
    expect(smtpAuthOf({ kind: "oauth", user: "u", issuer: "google", accessToken: "t" })).toEqual({
      type: "OAuth2",
      user: "u",
      accessToken: "t",
    });
    expect(() => imapAuthOf({ kind: "token", token: "x" })).toThrow();
  });

  test("OAuth-only detection and issuer by host", () => {
    expect(needsOAuth(["IMAP4rev1", "AUTH=XOAUTH2", "LOGINDISABLED"])).toBe(true);
    expect(needsOAuth(["IMAP4rev1", "AUTH=XOAUTH2"])).toBe(true);
    expect(needsOAuth(["IMAP4rev1", "AUTH=XOAUTH2", "AUTH=PLAIN"])).toBe(false);
    expect(oauthIssuerOfHost("imap.gmail.com")).toBe("google");
    expect(oauthIssuerOfHost("outlook.office365.com")).toBe("microsoft");
    expect(oauthIssuerOfHost("imap.fastmail.com")).toBeNull();
  });
});

describe("IMAP summaries", () => {
  test("header blocks unfold and decode encoded words", () => {
    const block =
      "List-Id: <dev.example.test>\r\nSubject: =?UTF-8?Q?Caf=C3=A9?=\r\n continued\r\nReferences: <a@x>\r\n <b@x>\r\n";
    const parsed = parseHeaderBlock(block);
    expect(parsed["list-id"]).toBe("<dev.example.test>");
    expect(parsed.subject).toBe("Café continued");
    expect(parsed.references).toBe("<a@x> <b@x>");
  });

  test("flags and attachments from FETCH", () => {
    expect(flagsOfSet(new Set(["\\Seen", "\\Flagged", "$label1"]))).toEqual({
      seen: true,
      flagged: true,
      answered: false,
      draft: false,
      keywords: ["$label1"],
    });
    expect(hasAttachmentParts({ type: "text/plain" })).toBe(false);
    expect(
      hasAttachmentParts({
        type: "multipart/mixed",
        childNodes: [
          { type: "text/plain" },
          { type: "application/pdf", disposition: "attachment" },
        ],
      }),
    ).toBe(true);
    const summary = summaryOfFetch("INBOX", "7", {
      seq: 1,
      uid: 42,
      size: 1234,
      flags: new Set(["\\Seen"]),
      internalDate: new Date("2026-09-16T10:00:00Z"),
      envelope: {
        date: "2026-09-16T09:59:00Z",
        subject: "Hi",
        messageId: "<m@x>",
        inReplyTo: "<p@x>",
        from: [{ name: "A", address: "a@x" }],
        to: [{ address: "me@x" }],
      },
      headers: Buffer.from("References: <r@x> <p@x>\r\nList-Id: <l.x>\r\n"),
    });
    expect(summary.id).toBe("INBOX:7:42");
    expect(summary.messageId).toBe("m@x");
    expect(summary.inReplyTo).toBe("p@x");
    expect(summary.references).toEqual(["r@x", "p@x"]);
    expect(summary.headers["list-id"]).toBe("<l.x>");
    expect(summary.from).toEqual({ name: "A", email: "a@x" });
    expect(summary.flags.seen).toBe(true);
    expect(summary.date).toBe("2026-09-16T09:59:00.000Z");
  });
});

describe("SMTP", () => {
  test("the envelope comes from the headers and Bcc never leaves", async () => {
    const mime = await composeMime({
      from: { name: "Me", email: "me@example.test" },
      to: [{ name: "A", email: "a@example.test" }],
      cc: [{ name: "B", email: "b@example.test" }],
      bcc: [{ name: "C", email: "c@example.test" }],
      subject: "Hi",
      text: "body",
    });
    // nodemailer already omits Bcc from the built message; add one to prove the strip.
    const withBcc = new TextEncoder().encode(
      `Bcc: c@example.test\r\n${new TextDecoder().decode(mime)}`,
    );
    const envelope = await envelopeOf(withBcc, "fallback@example.test");
    expect(envelope.from).toBe("me@example.test");
    expect(envelope.to.sort()).toEqual(["a@example.test", "b@example.test", "c@example.test"]);
    const stripped = new TextDecoder().decode(stripBcc(withBcc));
    expect(stripped.toLowerCase()).not.toContain("bcc:");
    expect(stripped).toContain("body");
  });
});

/** Timers the test fires by hand. */
function fakeTimers() {
  const scheduled: { id: number; fn: () => void; ms: number }[] = [];
  let next = 1;
  const timers: Timers = {
    setTimeout(fn, ms) {
      const id = next++;
      scheduled.push({ id, fn, ms });
      return id;
    },
    clearTimeout(handle) {
      const index = scheduled.findIndex((t) => t.id === handle);
      if (index >= 0) scheduled.splice(index, 1);
    },
  };
  return {
    timers,
    pending: () => scheduled.map((t) => t.ms),
    fire() {
      const t = scheduled.shift();
      if (!t) throw new Error("nothing scheduled");
      t.fn();
    },
  };
}

function fakeConnection() {
  const changeListeners = new Set<() => void>();
  let resolveIdle: (() => void) | null = null;
  let rejectIdle: ((e: Error) => void) | null = null;
  const conn = {
    opens: 0,
    idles: 0,
    wakes: 0,
    closed: false,
    failNextOpen: false,
    open: async () => {
      conn.opens += 1;
      if (conn.failNextOpen) {
        conn.failNextOpen = false;
        throw new Error("connect refused");
      }
    },
    idle: () =>
      new Promise<void>((resolve, reject) => {
        conn.idles += 1;
        resolveIdle = resolve;
        rejectIdle = reject;
      }),
    wake: async () => {
      conn.wakes += 1;
      resolveIdle?.();
      resolveIdle = null;
    },
    close: async () => {
      conn.closed = true;
    },
    onChange: (listener: () => void) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    notify: () => {
      for (const l of changeListeners) l();
    },
    drop: () => {
      rejectIdle?.(new Error("socket closed"));
      rejectIdle = null;
    },
  } satisfies IdleConnection & Record<string, unknown>;
  return conn;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("IDLE loop", () => {
  test("re-issues IDLE every 29 minutes and forwards mailbox changes", async () => {
    const conn = fakeConnection();
    const clock = fakeTimers();
    const events: WatchEvent[] = [];
    const loop = idleLoop("INBOX", conn, (e) => events.push(e), { timers: clock.timers });
    await tick();
    expect(conn.opens).toBe(1);
    expect(conn.idles).toBe(1);
    expect(clock.pending()).toEqual([IDLE_REISSUE_MS]);
    expect(IDLE_REISSUE_MS).toBe(29 * 60 * 1000);

    conn.notify();
    expect(events).toEqual([{ type: "connected" }, { type: "changed", mailboxIds: ["INBOX"] }]);

    // 29 minutes pass: the timer wakes the connection, IDLE is issued again on the same connection.
    clock.fire();
    await tick();
    await tick();
    expect(conn.wakes).toBe(1);
    expect(conn.idles).toBe(2);
    expect(conn.opens).toBe(1);
    expect(clock.pending()).toEqual([IDLE_REISSUE_MS]);
    expect(loop.issued()).toBe(2);

    await loop.stop();
    expect(conn.closed).toBe(true);
    expect(clock.pending()).toEqual([]);
  });

  test("a dropped socket reconnects with backoff and reports the gap", async () => {
    const conn = fakeConnection();
    const clock = fakeTimers();
    const sleeps: number[] = [];
    const events: WatchEvent[] = [];
    const loop = idleLoop("INBOX", conn, (e) => events.push(e), {
      timers: clock.timers,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      backoff: { initialMs: 100, maxMs: 400 },
    });
    await tick();
    conn.failNextOpen = true;
    conn.drop();
    await tick();
    await tick();
    await tick();
    expect(sleeps).toEqual([100, 200]);
    expect(conn.opens).toBe(3);
    expect(events.filter((e) => e.type === "disconnected")).toHaveLength(2);
    expect(events.filter((e) => e.type === "connected")).toHaveLength(2);
    await loop.stop();
  });
});
