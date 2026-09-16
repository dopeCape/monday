import { describe, expect, test } from "bun:test";
import {
  createFakeProvider,
  FIXTURE_MESSAGE_COUNT,
  fakeCredentials,
  generateFixture,
} from "../../src/providers/fake/index.ts";
import { addedOf, collect, providerConformance, stateOf, syncAll } from "./conformance.ts";

describe("fixture", () => {
  test("is deterministic: 60 messages across four folders with threads, flags and attachments", () => {
    const a = generateFixture();
    const b = generateFixture();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.messages).toHaveLength(FIXTURE_MESSAGE_COUNT);
    expect(new Set(a.messages.map((m) => m.mailbox))).toEqual(
      new Set(["inbox", "archive", "sent", "trash"]),
    );
    expect(new Set(a.messages.map((m) => m.threadKey)).size).toBe(24);
    expect(a.messages.some((m) => m.flagged)).toBe(true);
    expect(a.messages.some((m) => !m.seen)).toBe(true);
    expect(a.messages.filter((m) => m.attachments.length > 0)).toHaveLength(2);
    expect(a.messages.some((m) => m.headers["list-id"])).toBe(true);
    // Replies point at their parents.
    const byId = new Map(a.messages.map((m) => [m.messageId, m]));
    for (const m of a.messages) {
      if (m.inReplyTo) expect(byId.get(m.inReplyTo)?.threadKey).toBe(m.threadKey);
    }
    // Some Threads are older than the 90 day body window.
    const cutoff = Date.parse(a.recordedAt) - 90 * 86_400_000;
    expect(a.messages.some((m) => Date.parse(m.date) < cutoff)).toBe(true);
  });

  test("a different seed gives a different mailbox", () => {
    expect(JSON.stringify(generateFixture(1))).not.toBe(JSON.stringify(generateFixture(2)));
  });
});

providerConformance(
  "fake",
  async () => ({ provider: createFakeProvider(generateFixture()), credentials: fakeCredentials() }),
  { send: true, pushWaitMs: 1_000 },
);

providerConformance("fake with Provider threads", async () => ({
  provider: createFakeProvider(generateFixture(), { threads: true }),
  credentials: fakeCredentials(),
}));

describe("fake provider control surface", () => {
  test("deliver, setFlags, move and destroy show up as added, changed and removed", async () => {
    const fake = createFakeProvider(generateFixture());
    const session = await fake.connect(fakeCredentials());
    const inbox = (await session.listMailboxes()).find((m) => m.role === "inbox")?.id ?? "";
    const archive = (await session.listMailboxes()).find((m) => m.role === "archive")?.id ?? "";
    const first = await syncAll(session, inbox, null);
    const known = addedOf(first.events);

    const delivered = fake.deliver({
      mailbox: "inbox",
      threadKey: "new",
      from: { name: "New", email: "new@example.test" },
      to: [{ name: "Sam", email: "sam@monday.test" }],
      cc: [],
      subject: "Fresh",
      date: new Date().toISOString(),
      messageId: "fresh@example.test",
      inReplyTo: null,
      references: [],
      seen: false,
      flagged: false,
      answered: false,
      headers: {},
      text: "hello",
      html: null,
      attachments: [],
    });
    const target = known[0];
    const gone = known[1];
    if (!target || !gone) throw new Error("fixture too small");
    fake.setFlags(target.id, { seen: !target.flags.seen });
    fake.move(known[2]?.id ?? "", archive);
    fake.destroy(gone.id);

    const events = await collect(session.syncMailbox(inbox, first.state));
    expect(events.find((e) => e.type === "added" && e.message.id === delivered)).toBeDefined();
    const changed = events.find((e) => e.type === "changed" && e.id === target.id);
    expect(changed?.type === "changed" && changed.flags.seen).toBe(!target.flags.seen);
    const moved = events.find((e) => e.type === "changed" && e.id === known[2]?.id);
    expect(moved?.type === "changed" && moved.mailboxIds).toEqual([archive]);
    expect(events.find((e) => e.type === "removed" && e.id === gone.id)).toBeDefined();
    expect(stateOf(events).complete).toBe(true);
  });

  test("forgetting history makes an old state reset and refetch everything", async () => {
    const fake = createFakeProvider(generateFixture());
    const session = await fake.connect(fakeCredentials());
    const inbox = (await session.listMailboxes()).find((m) => m.role === "inbox")?.id ?? "";
    const first = await syncAll(session, inbox, null);
    fake.setFlags(addedOf(first.events)[0]?.id ?? "", { flagged: true });
    fake.forgetHistory();
    const events = await collect(session.syncMailbox(inbox, first.state));
    expect(events[0]?.type).toBe("reset");
    expect(addedOf(events)).toHaveLength(addedOf(first.events).length);
  });

  test("paging: limit bounds each call and the state resumes", async () => {
    const fake = createFakeProvider(generateFixture());
    const session = await fake.connect(fakeCredentials());
    const inbox = (await session.listMailboxes()).find((m) => m.role === "inbox")?.id ?? "";
    const page = await collect(session.syncMailbox(inbox, null, { limit: 4 }));
    expect(addedOf(page)).toHaveLength(4);
    expect(stateOf(page).complete).toBe(false);
    const all = await syncAll(session, inbox, null, 4);
    const full = await syncAll(session, inbox, null);
    expect(addedOf(all.events).map((m) => m.id)).toEqual(addedOf(full.events).map((m) => m.id));
  });

  test("a wrong password is an auth error", async () => {
    const fake = createFakeProvider(generateFixture());
    const creds = fakeCredentials();
    creds.auth = { kind: "password", user: creds.address, password: "wrong" };
    await expect(fake.connect(creds)).rejects.toMatchObject({ code: "auth" });
  });
});
