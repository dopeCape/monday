import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, ContentKind } from "@monday/shared";
import { DecryptError, HEADER_BYTES, randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys, LockedError } from "../src/crypto/keys.ts";
import {
  CONTENT_KINDS,
  createMailstore,
  type Mailstore,
  NotFoundError,
  SUBJECT_SEARCH_CHARS,
  subjectSearchOf,
} from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const account: Account = {
  id: "acct-fastmail",
  provider: "jmap",
  address: "aoife@example.test",
  displayName: "Aoife",
  capabilities: {
    push: true,
    labels: true,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
  },
};

/** 64 random lowercase letters: a word that cannot appear in ciphertext by chance. */
function marker(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const bytes = randomKey();
  let out = "";
  for (let i = 0; i < 64; i++) out += alphabet[(bytes[i % 32] ?? 0) % 26];
  return out;
}

function pseudoRandom(size: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = 99;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

describe("mailstore", () => {
  let db: TestDatabase;
  let keys: Keys;
  let store: Mailstore;
  let workspaceId = "";
  let threadId = "";
  let firstMessageId = "";
  let secondMessageId = "";
  let attachmentId = "";
  const bodyMarker = marker();
  const subjectMarker = marker();
  const snippetMarker = marker();
  const attachmentTextMarker = marker();
  const attachmentBytes = pseudoRandom(2 * 1024 * 1024 + 4096);

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    store = createMailstore(db.handle.db, keys);
    await keys.unlock(randomKey());
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  test("storeContent and readContent round trip every kind", async () => {
    const workspace = await store.createWorkspace(account);
    workspaceId = workspace.id;
    expect(workspace.accountId).toBe(account.id);

    for (const kind of CONTENT_KINDS) {
      const plaintext = `${kind} ${bodyMarker}`;
      const ref = await store.storeContent(workspaceId, kind, plaintext);
      expect(ref.kind).toBe(kind);
      expect(ref.workspaceId).toBe(workspaceId);
      expect(ref.size).toBe(plaintext.length);
      expect(ref.key.length).toBe(HEADER_BYTES + 32);
      expect(ref.chunks.length).toBe(1);
      expect(Buffer.from(ref.chunks[0] ?? []).includes(bodyMarker)).toBe(false);
      expect(await store.readText(ref)).toBe(plaintext);
    }

    // The kind is bound: a body cannot be read back as a brief.
    const body = await store.storeContent(workspaceId, "body", "x");
    await expect(store.readContent({ ...body, kind: "brief" })).rejects.toBeInstanceOf(
      DecryptError,
    );
    // Neither can it move to another Workspace.
    await expect(store.readContent({ ...body, workspaceId: "elsewhere" })).rejects.toThrow();

    // Attachments are chunked; a 2 MiB + 4 KiB payload is three chunks.
    const blob = await store.storeContent(workspaceId, "attachment", attachmentBytes);
    expect(blob.chunks.length).toBe(3);
    expect(Buffer.from(await store.readContent(blob)).equals(Buffer.from(attachmentBytes))).toBe(
      true,
    );
    const kinds: ContentKind[] = [...CONTENT_KINDS];
    expect(kinds).toContain("embedding");
  });

  test("a thread with two messages and one attachment round trips", async () => {
    threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: "T1",
      subject: `Re: Budget ${subjectMarker}`,
      participants: [{ name: "Aoife", email: "aoife@example.test" }],
      lastActivity: "2026-09-01T10:00:00.000Z",
      unread: true,
    });

    firstMessageId = await store.upsertMessage({
      threadId,
      providerMessageId: "M1",
      from: { name: "Tomas", email: "tomas@example.test" },
      to: [{ name: "Aoife", email: "aoife@example.test" }],
      cc: [],
      date: "2026-09-01T10:00:00.000Z",
      headers: { "message-id": "<m1@example.test>" },
      bodyText: `The number is ${bodyMarker}.`,
      bodyHtml: `<p>The number is ${bodyMarker}.</p>`,
      snippet: `The number is ${snippetMarker}`,
    });
    secondMessageId = await store.upsertMessage({
      threadId,
      providerMessageId: "M2",
      from: { name: "Aoife", email: "aoife@example.test" },
      to: [{ name: "Tomas", email: "tomas@example.test" }],
      cc: [],
      date: "2026-09-02T08:30:00.000Z",
      headers: { "message-id": "<m2@example.test>", "in-reply-to": "<m1@example.test>" },
      bodyText: "Thanks, sending the sheet.",
      bodyHtml: null,
      snippet: "Thanks, sending the sheet.",
    });
    attachmentId = await store.putAttachment(secondMessageId, {
      name: "budget.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: attachmentBytes,
      text: `Q3 totals ${attachmentTextMarker}`,
    });

    expect(await store.readThreadSubject(threadId)).toBe(`Re: Budget ${subjectMarker}`);
    const first = await store.readMessageBody(firstMessageId);
    expect(first).toEqual({
      text: `The number is ${bodyMarker}.`,
      html: `<p>The number is ${bodyMarker}.</p>`,
      snippet: `The number is ${snippetMarker}`,
    });
    const second = await store.readMessageBody(secondMessageId);
    expect(second.html).toBeNull();

    const attachment = await store.readAttachment(attachmentId);
    expect(attachment.name).toBe("budget.xlsx");
    expect(attachment.size).toBe(attachmentBytes.length);
    expect(Buffer.from(attachment.bytes).equals(Buffer.from(attachmentBytes))).toBe(true);
    expect(attachment.text).toBe(`Q3 totals ${attachmentTextMarker}`);

    // Message counters flowed to the Thread.
    const page = await store.listThreads(workspaceId, { limit: 10 });
    expect(page.threads).toHaveLength(1);
    expect(page.threads[0]).toMatchObject({
      id: threadId,
      messageCount: 2,
      hasAttachments: true,
      unread: true,
      lastActivity: "2026-09-02T08:30:00.000Z",
    });
  });

  test("psql sees no plaintext: every marker is absent from every encrypted column", async () => {
    const sql = db.handle.sql;
    const [msg] = await sql<{ body_enc: Buffer; snippet_enc: Buffer; body_key: Buffer }[]>`
      select body_enc, snippet_enc, body_key from messages where id = ${firstMessageId}
    `;
    expect(msg?.body_enc.length).toBeGreaterThan(HEADER_BYTES);
    for (const word of ["The", "number", bodyMarker, snippetMarker]) {
      expect(msg?.body_enc.includes(word)).toBe(false);
      expect(msg?.body_enc.includes(Buffer.from(word).toString("base64"))).toBe(false);
      expect(msg?.snippet_enc.includes(word)).toBe(false);
    }
    // Wrapped keys are envelopes too: 29-byte header plus a 32-byte key.
    expect(msg?.body_key.length).toBe(HEADER_BYTES + 32);

    const [thread] = await sql<{ subject_enc: Buffer; subject_search: string }[]>`
      select subject_enc, subject_search from threads where id = ${threadId}
    `;
    expect(thread?.subject_enc.includes(subjectMarker)).toBe(false);
    expect(thread?.subject_enc.includes("Budget")).toBe(false);
    // The documented leak: 80 lowercased characters, nothing more.
    expect(thread?.subject_search).toBe(
      `re: budget ${subjectMarker}`.slice(0, SUBJECT_SEARCH_CHARS),
    );
    expect(thread?.subject_search.length).toBeLessThanOrEqual(SUBJECT_SEARCH_CHARS);

    const [att] = await sql<{ text_enc: Buffer; name: string; size: number }[]>`
      select text_enc, name, size from attachments where id = ${attachmentId}
    `;
    expect(att?.text_enc.includes(attachmentTextMarker)).toBe(false);
    expect(att?.name).toBe("budget.xlsx");

    const chunks = await sql<{ index: number; data: Buffer }[]>`
      select c.index, c.data from blob_chunks c
      join attachments a on a.blob_id = c.blob_id
      where a.id = ${attachmentId} order by c.index
    `;
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
    const firstPlain = Buffer.from(attachmentBytes.subarray(0, 64));
    expect(chunks[0]?.data.includes(firstPlain)).toBe(false);

    // Nothing anywhere in the database holds the root key or any Workspace key in the clear.
    const [wk] = await sql<{ wrapped_key: Buffer }[]>`select wrapped_key from workspace_keys`;
    expect(wk?.wrapped_key.equals(Buffer.from(keys.rootKey()))).toBe(false);
    expect(wk?.wrapped_key.equals(Buffer.from(await keys.workspaceKey(workspaceId)))).toBe(false);
  });

  test("subjectSearchOf lowercases, collapses whitespace and cuts at 80", () => {
    expect(subjectSearchOf("  Hello   WORLD \n again ")).toBe("hello world again");
    expect(subjectSearchOf("x".repeat(200))).toHaveLength(80);
  });

  test("upserts are idempotent per provider id", async () => {
    const again = await store.upsertThread({
      workspaceId,
      providerThreadId: "T1",
      subject: "Re: Budget (edited)",
      participants: [],
      lastActivity: "2026-09-03T00:00:00.000Z",
      starred: true,
    });
    expect(again).toBe(threadId);
    expect(await store.readThreadSubject(threadId)).toBe("Re: Budget (edited)");
    const sameMessage = await store.upsertMessage({
      threadId,
      providerMessageId: "M1",
      from: { name: "Tomas", email: "tomas@example.test" },
      to: [],
      cc: [],
      date: "2026-09-01T10:00:00.000Z",
      headers: {},
      bodyText: "rewritten",
      bodyHtml: null,
      snippet: "rewritten",
    });
    expect(sameMessage).toBe(firstMessageId);
    expect((await store.readMessageBody(firstMessageId)).text).toBe("rewritten");
    const page = await store.listThreads(workspaceId, { limit: 10 });
    expect(page.threads[0]).toMatchObject({ messageCount: 2, starred: true });
  });

  test("labels and tags are plaintext and show in the projection", async () => {
    const inbox = await store.upsertLabel(workspaceId, { providerId: "INBOX", name: "Inbox" });
    const sameInbox = await store.upsertLabel(workspaceId, { providerId: "INBOX", name: "Inbox" });
    expect(sameInbox).toBe(inbox);
    const finance = await store.upsertTag(workspaceId, "finance");
    await store.setLabels(threadId, [inbox, inbox]);
    await store.setTags(threadId, [finance]);
    const page = await store.listThreads(workspaceId, { limit: 10 });
    expect(page.threads[0]?.labels).toEqual([inbox]);
    expect(page.threads[0]?.tags).toEqual([finance]);
    await store.setTags(threadId, []);
    expect((await store.listThreads(workspaceId, { limit: 10 })).threads[0]?.tags).toEqual([]);
    await expect(store.setTags("nope", [])).rejects.toBeInstanceOf(NotFoundError);
  });

  test("listThreads pages by activity, filters by section and group, and never decrypts", async () => {
    for (let i = 0; i < 5; i++) {
      await store.upsertThread({
        workspaceId,
        providerThreadId: `P${i}`,
        subject: `Page ${i} ${bodyMarker}`,
        participants: [],
        lastActivity: new Date(Date.UTC(2026, 8, 10 + i)).toISOString(),
        section: i % 2 === 0 ? "needs-reply" : "fyi",
        group: i < 2 ? "hiring" : null,
        subgroup: i === 1 ? "hiring-candidates" : null,
        archived: i === 4,
      });
    }
    const root = rootFor(keys);
    keys.lock();
    try {
      const first = await store.listThreads(workspaceId, { limit: 2 });
      expect(first.threads.map((t) => t.subject)).toEqual([
        `page 3 ${bodyMarker}`,
        `page 2 ${bodyMarker}`,
      ]);
      expect(first.threads.every((t) => t.snippet === "")).toBe(true);
      expect(first.cursor).not.toBeNull();
      const second = await store.listThreads(workspaceId, { limit: 2, cursor: first.cursor });
      expect(second.threads.map((t) => t.subject)).toEqual([
        `page 1 ${bodyMarker}`,
        `page 0 ${bodyMarker}`,
      ]);
      const third = await store.listThreads(workspaceId, { limit: 2, cursor: second.cursor });
      expect(third.threads.map((t) => t.id)).toEqual([threadId]);
      expect(third.cursor).toBeNull();

      const archived = await store.listThreads(workspaceId, { limit: 10, includeArchived: true });
      expect(archived.threads).toHaveLength(6);
      const fyi = await store.listThreads(workspaceId, { limit: 10, section: "fyi" });
      expect(fyi.threads.map((t) => t.section)).toEqual(["fyi", "fyi"]);
      const hiring = await store.listThreads(workspaceId, { limit: 10, group: "hiring" });
      expect(hiring.threads).toHaveLength(2);
      const candidates = await store.listThreads(workspaceId, {
        limit: 10,
        group: "hiring-candidates",
      });
      expect(candidates.threads).toHaveLength(1);
      await expect(store.listThreads(workspaceId, { limit: 1, cursor: "@@" })).rejects.toThrow(
        RangeError,
      );
    } finally {
      await keys.unlock(root);
    }
  });

  test("locked: content reads and writes fail with LockedError before touching rows", async () => {
    const root = rootFor(keys);
    keys.lock();
    try {
      await expect(store.readMessageBody(firstMessageId)).rejects.toBeInstanceOf(LockedError);
      await expect(store.readThreadSubject(threadId)).rejects.toBeInstanceOf(LockedError);
      await expect(store.readAttachment(attachmentId)).rejects.toBeInstanceOf(LockedError);
      await expect(
        store.upsertThread({
          workspaceId,
          providerThreadId: "LOCKED",
          subject: "never stored",
          participants: [],
          lastActivity: "2026-09-20T00:00:00.000Z",
        }),
      ).rejects.toBeInstanceOf(LockedError);
      await expect(
        store.upsertMessage({
          threadId,
          providerMessageId: "LOCKED",
          from: { name: "", email: "x@example.test" },
          to: [],
          cc: [],
          date: "2026-09-20T00:00:00.000Z",
          headers: {},
          bodyText: "never stored",
          bodyHtml: null,
          snippet: "",
        }),
      ).rejects.toBeInstanceOf(LockedError);
      await expect(
        store.putAttachment(firstMessageId, {
          name: "x",
          mediaType: "text/plain",
          bytes: new Uint8Array(3),
        }),
      ).rejects.toBeInstanceOf(LockedError);
      await expect(store.createWorkspace({ ...account, id: "acct-2" })).rejects.toBeInstanceOf(
        LockedError,
      );
      const rows = await db.handle.sql`
        select count(*)::int as n from threads where provider_thread_id = 'LOCKED'
      `;
      expect(rows[0]?.n).toBe(0);
      const accountsAfter = await db.handle.sql`select count(*)::int as n from accounts`;
      expect(accountsAfter[0]?.n).toBe(1);
      // Header work still succeeds locked.
      await store.setTags(threadId, []);
    } finally {
      await keys.unlock(root);
    }
  });

  test("rotating the Workspace key re-wraps every data key and everything still reads", async () => {
    const [before] = await db.handle.sql<{ body_enc: Buffer; body_key: Buffer }[]>`
      select body_enc, body_key from messages where id = ${firstMessageId}
    `;
    const result = await store.rotateWorkspaceKey(workspaceId);
    // 6 threads + 2 messages x 2 keys + 1 attachment text + 1 blob.
    expect(result).toEqual({ version: 2, rewrapped: 12 });
    const [after] = await db.handle.sql<{ body_enc: Buffer; body_key: Buffer }[]>`
      select body_enc, body_key from messages where id = ${firstMessageId}
    `;
    expect(after?.body_enc.equals(before?.body_enc ?? Buffer.alloc(0))).toBe(true);
    expect(after?.body_key.equals(before?.body_key ?? Buffer.alloc(0))).toBe(false);
    expect((await store.readMessageBody(firstMessageId)).text).toBe("rewritten");
    expect(await store.readThreadSubject(threadId)).toBe("Re: Budget (edited)");
    const attachment = await store.readAttachment(attachmentId);
    expect(Buffer.from(attachment.bytes).equals(Buffer.from(attachmentBytes))).toBe(true);
  });

  test("tampered ciphertext in the database is refused, not returned", async () => {
    await db.handle.sql`
      update messages set body_enc = set_byte(body_enc, 40, get_byte(body_enc, 40) # 1)
      where id = ${secondMessageId}
    `;
    await expect(store.readMessageBody(secondMessageId)).rejects.toBeInstanceOf(DecryptError);
    await expect(store.readMessageBody("missing")).rejects.toBeInstanceOf(NotFoundError);
  });
});

/** The root key currently in a holder; tests re-unlock with it after locking. */
function rootFor(keys: Keys): Uint8Array {
  return keys.rootKey();
}
