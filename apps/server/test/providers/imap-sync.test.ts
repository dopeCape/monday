// The IMAP adapter's sync, fetch and action paths over a scripted stand-in for
// imapflow: the subset of its API the adapter calls, with per-tier behaviour
// (QRESYNC VANISHED, CONDSTORE CHANGEDSINCE, plain flag scans).

import { describe, expect, test } from "bun:test";
import type { ImapFlow, ImapFlowOptions } from "imapflow";
import { createImapProvider } from "../../src/providers/imap/index.ts";
import { decodeImapState, parseMessageId } from "../../src/providers/imap/tiers.ts";
import type { Credentials, SyncEvent } from "../../src/providers/types.ts";
import { addedOf, collect, stateOf, syncAll } from "./conformance.ts";

interface StoredMessage {
  uid: number;
  flags: Set<string>;
  modseq: bigint;
  subject: string;
  messageId: string;
  date: Date;
  source: string;
}

interface Folder {
  path: string;
  uidValidity: bigint;
  next: number;
  highestModseq: bigint;
  messages: Map<number, StoredMessage>;
  vanished: { uid: number; modseq: bigint }[];
  specialUse?: string;
}

type Tier = "qresync" | "condstore" | "full-scan";

class FakeImapFlow {
  capabilities = new Map<string, boolean>();
  enabled = new Set<string>();
  mailbox: Record<string, unknown> | false = false;
  usable = true;
  isClosed = false;
  folders = new Map<string, Folder>();
  calls: string[] = [];
  private listeners = new Map<string, Set<(e: unknown) => void>>();
  private modseq = 10n;

  constructor(
    readonly tier: Tier,
    readonly options: ImapFlowOptions,
  ) {
    this.capabilities.set("IMAP4REV1", true);
    this.capabilities.set("IDLE", true);
    this.capabilities.set("MOVE", true);
    this.capabilities.set("SPECIAL-USE", true);
    if (tier !== "full-scan") this.capabilities.set("CONDSTORE", true);
    if (tier === "qresync") {
      this.capabilities.set("QRESYNC", true);
      this.enabled.add("QRESYNC");
      this.enabled.add("CONDSTORE");
    }
    for (const [path, specialUse] of [
      ["INBOX", undefined],
      ["Archive", "\\Archive"],
      ["Sent", "\\Sent"],
      ["Trash", "\\Trash"],
    ] as const) {
      this.folders.set(path, {
        path,
        uidValidity: 1000n,
        next: 1,
        highestModseq: this.modseq,
        messages: new Map(),
        vanished: [],
        ...(specialUse ? { specialUse } : {}),
      });
    }
  }

  private bump(folder: Folder): bigint {
    this.modseq += 1n;
    folder.highestModseq = this.modseq;
    return this.modseq;
  }

  /** Test control: another client delivers. */
  deliver(path: string, subject: string, flags: string[] = []): number {
    const folder = this.folder(path);
    const uid = folder.next++;
    const modseq = this.bump(folder);
    folder.messages.set(uid, {
      uid,
      flags: new Set(flags),
      modseq,
      subject,
      messageId: `${path}-${uid}@fake.test`,
      date: new Date(Date.UTC(2026, 8, 1) + uid * 3_600_000),
      source: `From: a@fake.test\r\nTo: me@fake.test\r\nSubject: ${subject}\r\nMessage-ID: <${path}-${uid}@fake.test>\r\nDate: Tue, 1 Sep 2026 10:00:00 +0000\r\n\r\nBody of ${subject}\r\n`,
    });
    return uid;
  }

  setFlag(path: string, uid: number, flag: string, on: boolean): void {
    const folder = this.folder(path);
    const m = folder.messages.get(uid);
    if (!m) throw new Error(`${path} ${uid}`);
    if (on) m.flags.add(flag);
    else m.flags.delete(flag);
    m.modseq = this.bump(folder);
  }

  expunge(path: string, uid: number): void {
    const folder = this.folder(path);
    folder.messages.delete(uid);
    folder.vanished.push({ uid, modseq: this.bump(folder) });
  }

  changeUidValidity(path: string): void {
    this.folder(path).uidValidity += 1n;
  }

  private folder(path: string): Folder {
    const f = this.folders.get(path);
    if (!f) throw new Error(`no folder ${path}`);
    return f;
  }

  private uids(folder: Folder, range: unknown): number[] {
    const all = [...folder.messages.keys()].sort((a, b) => a - b);
    if (Array.isArray(range)) return range.filter((u) => folder.messages.has(u));
    const text = String(range);
    const [lo, hi] = text.split(":");
    const from = Number(lo);
    const max = all.at(-1) ?? 0;
    const to =
      hi === "*" || hi === undefined ? (hi === undefined ? from : Math.max(max, from)) : Number(hi);
    // "N:*" includes the highest UID even when it is below N (RFC 9051 section 6.4.9).
    if (hi === "*" && from > max && max > 0) return [max];
    return all.filter((u) => u >= from && u <= to);
  }

  private emit(event: string, payload: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(payload);
  }

  // The imapflow surface the adapter uses.
  on(event: string, listener: (e: unknown) => void): this {
    this.listeners.set(event, (this.listeners.get(event) ?? new Set()).add(listener));
    return this;
  }
  off(event: string, listener: (e: unknown) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  async connect(): Promise<void> {
    this.calls.push("connect");
    if (this.options.auth?.pass === "wrong") {
      const { AuthenticationFailure } = await import("imapflow");
      throw new AuthenticationFailure("bad credentials");
    }
  }
  async logout(): Promise<void> {
    this.isClosed = true;
  }
  close(): void {
    this.isClosed = true;
  }
  async list() {
    this.calls.push("list");
    return [...this.folders.values()].map((f) => ({
      path: f.path,
      pathAsListed: f.path,
      name: f.path,
      delimiter: "/",
      parent: [],
      parentPath: "",
      flags: new Set<string>(f.specialUse ? [f.specialUse] : []),
      specialUse: f.specialUse,
      listed: true,
      subscribed: true,
    }));
  }
  async mailboxOpen(path: string) {
    const f = this.folder(path);
    this.mailbox = {
      path,
      uidValidity: f.uidValidity,
      uidNext: f.next,
      exists: f.messages.size,
      ...(this.tier !== "full-scan" ? { highestModseq: f.highestModseq } : { noModseq: true }),
    };
    return this.mailbox;
  }
  async getMailboxLock(path: string) {
    this.calls.push(`lock ${path}`);
    await this.mailboxOpen(path);
    return { path, release: () => {} };
  }
  async search(_query: unknown, _options: unknown): Promise<number[]> {
    this.calls.push("search");
    const f = this.folder(String((this.mailbox as { path: string }).path));
    return [...f.messages.keys()].sort((a, b) => a - b);
  }
  async fetchAll(
    range: unknown,
    query: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ) {
    const path = String((this.mailbox as { path: string }).path);
    const f = this.folder(path);
    const changedSince = options.changedSince as bigint | undefined;
    this.calls.push(`fetch ${changedSince !== undefined ? "changedsince" : "plain"}`);
    if (changedSince !== undefined && this.enabled.has("QRESYNC")) {
      for (const v of f.vanished) {
        if (v.modseq > changedSince)
          this.emit("expunge", { path, uid: v.uid, vanished: true, earlier: true });
      }
    }
    return this.uids(f, range)
      .map((uid) => f.messages.get(uid))
      .filter((m): m is StoredMessage => m !== undefined)
      .filter((m) => changedSince === undefined || m.modseq > changedSince)
      .map((m, index) => ({
        seq: index + 1,
        uid: m.uid,
        modseq: m.modseq,
        flags: new Set(m.flags),
        size: m.source.length,
        internalDate: m.date,
        ...(query.envelope
          ? {
              envelope: {
                date: m.date,
                subject: m.subject,
                messageId: `<${m.messageId}>`,
                from: [{ name: "A", address: "a@fake.test" }],
                to: [{ address: "me@fake.test" }],
              },
            }
          : {}),
        ...(query.headers ? { headers: Buffer.from("") } : {}),
        ...(query.bodyStructure ? { bodyStructure: { type: "text/plain" } } : {}),
        ...(query.source ? { source: Buffer.from(m.source) } : {}),
      }));
  }
  async fetchOne(seq: string, query: Record<string, unknown>, options: Record<string, unknown>) {
    const rows = await this.fetchAll([Number(seq)], query, options);
    return rows[0] ?? false;
  }
  async messageFlagsAdd(range: number[], flags: string[]) {
    const path = String((this.mailbox as { path: string }).path);
    for (const uid of range) for (const flag of flags) this.setFlag(path, uid, flag, true);
    return true;
  }
  async messageFlagsRemove(range: number[], flags: string[]) {
    const path = String((this.mailbox as { path: string }).path);
    for (const uid of range) for (const flag of flags) this.setFlag(path, uid, flag, false);
    return true;
  }
  async messageMove(range: number[], destination: string) {
    const path = String((this.mailbox as { path: string }).path);
    const from = this.folder(path);
    const to = this.folder(destination);
    const uidMap = new Map<number, number>();
    for (const uid of range) {
      const m = from.messages.get(uid);
      if (!m) continue;
      const newUid = to.next++;
      to.messages.set(newUid, { ...m, uid: newUid, modseq: this.bump(to) });
      uidMap.set(uid, newUid);
      this.expunge(path, uid);
    }
    return { path, destination, uidMap };
  }
  async mailboxCreate(path: string) {
    this.folders.set(path, {
      path,
      uidValidity: 2000n,
      next: 1,
      highestModseq: this.modseq,
      messages: new Map(),
      vanished: [],
    });
    return { path, created: true };
  }
  async append(path: string, content: Buffer, flags: string[] = []) {
    const uid = this.deliver(path, "appended", flags);
    const m = this.folder(path).messages.get(uid);
    if (m) m.source = content.toString();
    return { destination: path, uid, uidValidity: this.folder(path).uidValidity };
  }
  async idle() {
    return true;
  }
  async noop() {}
}

function credentials(): Credentials {
  return {
    address: "me@fake.test",
    auth: { kind: "password", user: "me@fake.test", password: "pw" },
    endpoint: {
      kind: "imap",
      imap: { host: "imap.fake.test", port: 993, tls: "tls" },
      smtp: { host: "smtp.fake.test", port: 465, tls: "tls" },
    },
  };
}

async function connect(tier: Tier) {
  let fake: FakeImapFlow | null = null;
  const provider = createImapProvider({
    createClient: (options) => {
      fake ??= new FakeImapFlow(tier, options);
      return fake as unknown as ImapFlow;
    },
  });
  const session = await provider.connect(credentials());
  if (!fake) throw new Error("no client");
  return { session, fake: fake as FakeImapFlow };
}

const uidsOf = (events: SyncEvent[]) => addedOf(events).map((m) => parseMessageId(m.id).uid);

describe("IMAP sync over a scripted server", () => {
  for (const tier of ["qresync", "condstore", "full-scan"] as const) {
    test(`${tier}: first pass newest first and paged, then adds, flag changes and expunges`, async () => {
      const { session, fake } = await connect(tier);
      expect(session.capabilities().syncTier).toBe(tier);
      for (let i = 1; i <= 7; i++) fake.deliver("INBOX", `m${i}`, i % 2 ? ["\\Seen"] : []);
      fake.deliver("Archive", "old");

      const page = await collect(session.syncMailbox("INBOX", null, { limit: 3 }));
      expect(uidsOf(page)).toEqual([7, 6, 5]);
      expect(stateOf(page).complete).toBe(false);
      const rest = await syncAll(session, "INBOX", stateOf(page).state, 3);
      expect(uidsOf(rest.events)).toEqual([4, 3, 2, 1]);
      const stored = decodeImapState(rest.state);
      expect(stored?.tier).toBe(tier);
      expect(stored?.known).toBe("1:7");
      expect(stored?.seen).toBe("1,3,5,7");
      expect(stored?.complete).toBe(true);
      expect(addedOf(page)[0]?.id).toBe("INBOX:1000:7");

      // Quiet: nothing but a state. QRESYNC needs no UID scan for that.
      fake.calls.length = 0;
      const quiet = await collect(session.syncMailbox("INBOX", rest.state));
      expect(quiet.filter((e) => e.type !== "state")).toHaveLength(0);
      expect(fake.calls.includes("search")).toBe(tier !== "qresync");

      // Another client acts.
      const added = fake.deliver("INBOX", "m8");
      fake.setFlag("INBOX", 2, "\\Seen", true);
      fake.setFlag("INBOX", 3, "\\Flagged", true);
      fake.expunge("INBOX", 4);
      fake.calls.length = 0;
      const events = await collect(session.syncMailbox("INBOX", stateOf(quiet).state));
      expect(uidsOf(events)).toEqual([added]);
      const changed = events.filter((e) => e.type === "changed");
      expect(
        changed.map((e) => (e.type === "changed" ? parseMessageId(e.id).uid : 0)).sort(),
      ).toEqual([2, 3]);
      expect(
        events.filter((e) => e.type === "removed").map((e) => (e.type === "removed" ? e.id : "")),
      ).toEqual(["INBOX:1000:4"]);
      const next = decodeImapState(stateOf(events).state);
      expect(next?.known).toBe("1:3,5:8");
      expect(next?.flagged).toBe("3");
      if (tier === "full-scan") expect(fake.calls).toContain("fetch plain");
      else expect(fake.calls).toContain("fetch changedsince");
    });
  }

  test("a UIDVALIDITY change resets the mailbox", async () => {
    const { session, fake } = await connect("condstore");
    fake.deliver("INBOX", "a");
    const first = await syncAll(session, "INBOX", null);
    fake.changeUidValidity("INBOX");
    const events = await collect(session.syncMailbox("INBOX", first.state));
    expect(events[0]?.type).toBe("reset");
    expect(uidsOf(events)).toEqual([1]);
    expect(addedOf(events)[0]?.id).toBe("INBOX:1001:1");
  });

  test("actions: flags, archive creates the folder when missing, delete moves to Trash", async () => {
    const { session, fake } = await connect("qresync");
    fake.folders.delete("Archive");
    const uid = fake.deliver("INBOX", "act");
    const id = `INBOX:1000:${uid}`;
    await session.applyChange({ messageIds: [id] }, { kind: "read", value: true });
    await session.applyChange({ messageIds: [id] }, { kind: "star", value: true });
    expect([...(fake.folders.get("INBOX")?.messages.get(uid)?.flags ?? [])].sort()).toEqual([
      "\\Flagged",
      "\\Seen",
    ]);
    await session.applyChange({ messageIds: [id] }, { kind: "archive" });
    expect(fake.folders.get("Archive")?.messages.size).toBe(1);
    expect(fake.folders.get("INBOX")?.messages.size).toBe(0);
    const moved = `Archive:2000:1`;
    await session.applyChange({ messageIds: [moved] }, { kind: "delete" });
    expect(fake.folders.get("Trash")?.messages.size).toBe(1);
    await expect(session.applyChange({ threadId: "t" }, { kind: "archive" })).rejects.toMatchObject(
      { code: "unsupported" },
    );
    await expect(
      session.applyChange({ messageIds: [id] }, { kind: "label", add: ["x"], remove: [] }),
    ).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  test("fetchMessage parses the raw source; listMailboxes reports roles; bad credentials fail as auth", async () => {
    const { session, fake } = await connect("full-scan");
    const uid = fake.deliver("INBOX", "raw one");
    const raw = await session.fetchMessage(`INBOX:1000:${uid}`);
    expect(raw.text.trim()).toBe("Body of raw one");
    expect(raw.headers.subject).toBe("raw one");
    const mailboxes = await session.listMailboxes();
    expect(mailboxes.map((m) => [m.id, m.role])).toEqual([
      ["INBOX", "inbox"],
      ["Archive", "archive"],
      ["Sent", "sent"],
      ["Trash", "trash"],
    ]);
    const caps = session.capabilities();
    expect(caps.push).toBe(true);
    expect(caps.savesSentCopy).toBe(false);
    await session.close();

    const bad = createImapProvider({
      createClient: (options) => new FakeImapFlow("full-scan", options) as unknown as ImapFlow,
    });
    const creds = credentials();
    creds.auth = { kind: "password", user: "me", password: "wrong" };
    await expect(bad.connect(creds)).rejects.toMatchObject({ code: "auth" });
  });

  test("send appends to Sent unless the host keeps its own copy", async () => {
    const sent: Uint8Array[] = [];
    const transport = {
      sendMail: async (m: { raw: Buffer }) => {
        sent.push(new Uint8Array(m.raw));
        return { accepted: ["a@fake.test"] };
      },
      close() {},
    };
    let fake: FakeImapFlow | null = null;
    const provider = createImapProvider({
      createClient: (options) => {
        fake ??= new FakeImapFlow("qresync", options);
        return fake as unknown as ImapFlow;
      },
      smtp: { createTransport: () => transport as never },
    });
    const session = await provider.connect(credentials());
    const mime = new TextEncoder().encode(
      "From: me@fake.test\r\nTo: a@fake.test\r\nSubject: out\r\n\r\nhi\r\n",
    );
    const result = await session.send(mime);
    expect(sent).toHaveLength(1);
    expect(result.messageId).toBe("Sent:1000:1");
    expect((fake as unknown as FakeImapFlow).folders.get("Sent")?.messages.size).toBe(1);

    const gmail = credentials();
    gmail.endpoint = {
      kind: "imap",
      imap: { host: "imap.gmail.com", port: 993, tls: "tls" },
      smtp: { host: "smtp.gmail.com", port: 465, tls: "tls" },
    };
    const g = await createImapProvider({
      createClient: (options) => new FakeImapFlow("full-scan", options) as unknown as ImapFlow,
      smtp: { createTransport: () => transport as never },
    }).connect(gmail);
    expect(g.capabilities().savesSentCopy).toBe(true);
    expect(await g.send(mime)).toEqual({ messageId: null });
  });
});
