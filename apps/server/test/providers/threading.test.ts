import { describe, expect, test } from "bun:test";
import {
  isReplySubject,
  normalizeSubject,
  resolveThread,
  type ThreadLookup,
} from "../../src/providers/threading.ts";
import { EMPTY_FLAGS, type MessageSummary } from "../../src/providers/types.ts";

function summary(patch: Partial<MessageSummary>): MessageSummary {
  return {
    id: "p1",
    threadId: null,
    mailboxIds: ["INBOX"],
    flags: EMPTY_FLAGS,
    from: { name: "A", email: "a@example.test" },
    to: [{ name: "Me", email: "me@example.test" }],
    cc: [],
    subject: "Hello",
    date: "2026-09-16T10:00:00Z",
    receivedAt: "2026-09-16T10:00:00Z",
    messageId: "m1@example.test",
    inReplyTo: null,
    references: [],
    headers: {},
    size: 100,
    hasAttachments: false,
    preview: null,
    ...patch,
  };
}

function lookup(
  byMessageId: Record<string, string>,
  bySubject: Record<string, string> = {},
): ThreadLookup {
  return {
    async threadOfMessageId(id) {
      return byMessageId[id] ?? null;
    },
    async threadOfSubject(subject, participants) {
      return participants.length > 0 ? (bySubject[subject] ?? null) : null;
    },
  };
}

describe("threading", () => {
  test("normalizeSubject strips reply and forward prefixes, list tags and case", () => {
    expect(normalizeSubject("Re: Re: FWD: [list] Hello  World")).toBe("hello world");
    expect(normalizeSubject("AW: Fw: Hallo")).toBe("hallo");
    expect(normalizeSubject("Re[2]: nested")).toBe("nested");
    expect(isReplySubject("Re: x")).toBe(true);
    expect(isReplySubject("x")).toBe(false);
  });

  test("the Provider's Thread id wins", async () => {
    const d = await resolveThread(summary({ threadId: "T9" }), lookup({}));
    expect(d).toEqual({ key: "T9", by: "provider" });
  });

  test("In-Reply-To, then References newest to oldest", async () => {
    const l = lookup({ "root@example.test": "T1", "mid@example.test": "T2" });
    const viaReply = await resolveThread(
      summary({ inReplyTo: "mid@example.test", references: ["root@example.test"] }),
      l,
    );
    expect(viaReply).toEqual({ key: "T2", by: "references" });
    const viaRefs = await resolveThread(
      summary({
        inReplyTo: "unknown@example.test",
        references: ["root@example.test", "gone@example.test"],
      }),
      l,
    );
    expect(viaRefs).toEqual({ key: "T1", by: "references" });
  });

  test("subject fallback only for replies, only with a shared participant, excluding the own address", async () => {
    const l = lookup({}, { hello: "T3" });
    const reply = await resolveThread(
      summary({ subject: "Re: Hello" }),
      l,
      new Date(),
      "me@example.test",
    );
    expect(reply).toEqual({ key: "T3", by: "subject" });
    const notReply = await resolveThread(summary({ subject: "Hello" }), l);
    expect(notReply.by).toBe("new");
    // Only the own address on the Message: no evidence of a shared participant.
    const lonely = await resolveThread(
      summary({ subject: "Re: Hello", from: { name: "Me", email: "me@example.test" }, to: [] }),
      l,
      new Date(),
      "me@example.test",
    );
    expect(lonely.by).toBe("new");
  });

  test("a fresh Thread is keyed by the Message-ID, else the Provider id", async () => {
    expect((await resolveThread(summary({}), lookup({}))).key).toBe("mid:m1@example.test");
    expect((await resolveThread(summary({ messageId: null }), lookup({}))).key).toBe("pid:p1");
  });
});
