/// <reference types="bun-types" />
// The compose rules as data: autosave debounces on a fake clock and saves at
// once on flush (blur), the reply-all rule and recipients, reply and forward
// content, upload progress through the Composer, and the send countdown.

import { describe, expect, test } from "bun:test";
import type { DraftContent, Message } from "@monday/shared";
import { createAutosave } from "./autosave.ts";
import { fixtureComposer } from "./composer.ts";
import {
  forwardSubject,
  initialContent,
  parseRecipient,
  quotedReply,
  replyRecipients,
  replySubject,
  shouldReplyAll,
  signatureFor,
} from "./reply.ts";
import { isLater, secondsLeft } from "./UndoBar.tsx";

/** A fake timer queue the autosave schedules into. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms: number) => {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number);
    },
    async advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
          await Promise.resolve();
          await Promise.resolve();
        }
      }
    },
    pending: () => timers.size,
  };
}

const content = (over: Partial<DraftContent> = {}): DraftContent => ({
  threadId: null,
  kind: "new",
  inReplyToMessageId: null,
  to: [{ name: "Aoife", email: "aoife@northlight.dev" }],
  cc: [],
  bcc: [],
  subject: "Hi",
  bodyHtml: "<p>x</p>",
  bodyText: "x",
  attachments: [],
  ...over,
});

describe("autosave", () => {
  test("saves once after the idle window, not on every keystroke", async () => {
    const clock = fakeTimers();
    const saved: DraftContent[] = [];
    const states: boolean[] = [];
    const auto = createAutosave({
      idleMs: 2000,
      save: async (c) => {
        saved.push(c);
      },
      onState: (s) => states.push(s),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    auto.change(content({ subject: "H" }));
    await clock.advance(1000);
    auto.change(content({ subject: "Hi" }));
    await clock.advance(1000);
    expect(saved).toHaveLength(0);
    expect(auto.pending).toBe(true);
    await clock.advance(1000);
    expect(saved.map((c) => c.subject)).toEqual(["Hi"]);
    expect(auto.pending).toBe(false);
    expect(states).toEqual([true, true, false]);
    // The same content again is not a change.
    auto.change(content({ subject: "Hi" }));
    expect(clock.pending()).toBe(0);
  });

  test("flush saves now and cancel drops the timer", async () => {
    const clock = fakeTimers();
    const saved: string[] = [];
    const auto = createAutosave({
      idleMs: 2000,
      save: async (c) => {
        saved.push(c.subject);
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    auto.change(content({ subject: "blur me" }));
    await auto.flush();
    expect(saved).toEqual(["blur me"]);
    expect(clock.pending()).toBe(0);
    auto.change(content({ subject: "dropped" }));
    auto.cancel();
    await clock.advance(5000);
    expect(saved).toEqual(["blur me"]);
    expect(auto.count).toBe(1);
  });

  test("a change during a save schedules another save", async () => {
    const clock = fakeTimers();
    const saved: string[] = [];
    const releases: Array<() => void> = [];
    const auto = createAutosave({
      idleMs: 100,
      save: (c) =>
        new Promise<void>((resolve) => {
          releases.push(() => {
            saved.push(c.subject);
            resolve();
          });
        }),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    auto.change(content({ subject: "one" }));
    await clock.advance(100);
    auto.change(content({ subject: "two" }));
    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    await clock.advance(100);
    releases.shift()?.();
    await Promise.resolve();
    expect(saved).toEqual(["one", "two"]);
  });
});

const me = "tejas@genai-labs.io";
const aoife = { name: "Aoife Brennan", email: "aoife@northlight.dev" };
const ravi = { name: "Ravi Shankar", email: "ravi@genai-labs.io" };
const tejas = { name: "Tejas", email: me };
const msg = (over: Partial<Message> = {}): Message => ({
  id: "m1",
  threadId: "t1",
  from: aoife,
  to: [tejas],
  cc: [],
  date: "2026-09-16T09:41:00Z",
  bodyText: "Hi Tejas,\n\nSee the repo.",
  attachments: [],
  ...over,
});

describe("reply rules (ADR 0010)", () => {
  test("reply-all when the last Message had more than one other recipient", () => {
    const one = msg();
    const many = msg({ to: [tejas, ravi] });
    const none = { remembered: null, settingDefault: false };
    expect(shouldReplyAll(one, me, none)).toBe(false);
    expect(shouldReplyAll(many, me, none)).toBe(true);
    // The remembered choice wins over the rule; the Setting over the rule.
    expect(shouldReplyAll(many, me, { remembered: false, settingDefault: false })).toBe(false);
    expect(shouldReplyAll(one, me, { remembered: true, settingDefault: false })).toBe(true);
    expect(shouldReplyAll(one, me, { remembered: null, settingDefault: true })).toBe(true);
  });

  test("recipients: sender to To, the rest to Cc, me left out", () => {
    const many = msg({ to: [tejas, ravi], cc: [{ name: "Priya", email: "priya@genai-labs.io" }] });
    expect(replyRecipients(many, me, false)).toEqual({ to: [aoife], cc: [] });
    expect(replyRecipients(many, me, true)).toEqual({
      to: [aoife],
      cc: [ravi, { name: "Priya", email: "priya@genai-labs.io" }],
    });
    // Replying to my own Message answers its recipients.
    const mine = msg({ from: tejas, to: [aoife, ravi] });
    expect(replyRecipients(mine, me, false)).toEqual({ to: [aoife], cc: [] });
    expect(replyRecipients(mine, me, true)).toEqual({ to: [aoife, ravi], cc: [] });
  });

  test("subjects", () => {
    expect(replySubject("Term sheet")).toBe("Re: Term sheet");
    expect(replySubject("RE: Term sheet")).toBe("RE: Term sheet");
    expect(forwardSubject("Term sheet")).toBe("Fwd: Term sheet");
    expect(forwardSubject("Fwd: Term sheet")).toBe("Fwd: Term sheet");
  });

  test("a reply starts above the folded history with the signature; a forward carries attachments", () => {
    const strings = { wrote: "On {date}, {name} wrote:", forwarded: "Forwarded message" };
    const format = () => "Today 09:41";
    const signature = signatureFor(me, { [me]: "Tejas\nGenAI Labs" }, "shared");
    expect(signature.text).toBe("Tejas\nGenAI Labs");
    expect(signatureFor("other@x.y", { [me]: "mine" }, "shared").text).toBe("shared");
    const reply = initialContent({
      threadId: "t1",
      kind: "reply",
      last: msg({ to: [tejas, ravi] }),
      subject: "Term sheet",
      me,
      replyAll: true,
      signature,
      strings,
      formatDate: format,
    });
    expect(reply.to).toEqual([aoife]);
    expect(reply.cc).toEqual([ravi]);
    expect(reply.subject).toBe("Re: Term sheet");
    expect(reply.inReplyToMessageId).toBe("m1");
    expect(reply.bodyHtml).toBe(
      '<p></p><p>Tejas<br>GenAI Labs</p><div class="quoted"><p>On Today 09:41, Aoife Brennan &lt;aoife@northlight.dev&gt; wrote:</p><blockquote><p>Hi Tejas,</p><p>See the repo.</p></blockquote></div>',
    );
    expect(reply.bodyText).toBe(
      "\n\nTejas\nGenAI Labs\n\nOn Today 09:41, Aoife Brennan <aoife@northlight.dev> wrote:\n> Hi Tejas,\n> \n> See the repo.",
    );
    const { bodyText: _t, ...richOnly } = msg({ bodyHtml: "<p>rich</p>" });
    const quoted = quotedReply(richOnly, strings, format);
    expect(quoted.html).toContain("<blockquote><p>rich</p></blockquote>");
    expect(quoted.text).toContain("> rich");

    const forward = initialContent({
      threadId: "t1",
      kind: "forward",
      last: msg({
        attachments: [{ id: "a1", name: "cv.pdf", size: 10, mediaType: "application/pdf" }],
      }),
      subject: "Term sheet",
      me,
      replyAll: false,
      signature: { html: "", text: "" },
      strings,
      formatDate: format,
      attachments: [{ blobId: "att:a1", name: "cv.pdf", size: 10, mediaType: "application/pdf" }],
    });
    expect(forward.to).toEqual([]);
    expect(forward.subject).toBe("Fwd: Term sheet");
    expect(forward.attachments).toEqual([
      { blobId: "att:a1", name: "cv.pdf", size: 10, mediaType: "application/pdf" },
    ]);
    expect(forward.bodyText).toContain("---------- Forwarded message ----------");
    expect(forward.bodyText).toContain("From: Aoife Brennan <aoife@northlight.dev>");
    expect(forward.bodyHtml).toContain('<div class="quoted">');
  });

  test("a Brief chip seeds a reply with its opening line, or a forward with its person, still unsent (slice 13)", () => {
    const strings = { wrote: "On {date}, {name} wrote:", forwarded: "Forwarded message" };
    const format = () => "Today 09:41";
    const reply = initialContent({
      threadId: "t1",
      kind: "reply",
      last: msg(),
      subject: "Term sheet",
      me,
      replyAll: false,
      signature: { html: "<p>Tejas</p>", text: "Tejas" },
      strings,
      formatDate: format,
      opening: "Thursday 15:00 CET works for me.",
    });
    expect(reply.to).toEqual([aoife]);
    expect(reply.bodyHtml.startsWith("<p>Thursday 15:00 CET works for me.</p><p>Tejas</p>")).toBe(
      true,
    );
    expect(
      reply.bodyText.startsWith("Thursday 15:00 CET works for me.\n\n\nTejas\n\nOn Today"),
    ).toBe(true);
    const forward = initialContent({
      threadId: "t1",
      kind: "forward",
      last: msg(),
      subject: "Term sheet",
      me,
      replyAll: false,
      signature: { html: "", text: "" },
      strings,
      formatDate: format,
      to: [ravi],
    });
    expect(forward.to).toEqual([ravi]);
    expect(forward.subject).toBe("Fwd: Term sheet");
    expect(forward.bodyHtml.startsWith("<p></p>")).toBe(true);
    // An opening with markup stays text.
    const escaped = initialContent({
      threadId: null,
      kind: "new",
      last: null,
      subject: "",
      me,
      replyAll: false,
      signature: { html: "", text: "" },
      strings,
      formatDate: format,
      opening: "<b>hi</b>",
    });
    expect(escaped.bodyHtml).toBe("<p>&lt;b&gt;hi&lt;/b&gt;</p>");
    expect(escaped.bodyText).toBe("<b>hi</b>\n");
  });

  test("typed recipients parse", () => {
    expect(parseRecipient("aoife@northlight.dev")).toEqual({
      name: "",
      email: "aoife@northlight.dev",
    });
    expect(parseRecipient("Aoife Brennan <aoife@northlight.dev>")).toEqual(aoife);
    expect(parseRecipient("nope")).toBeNull();
  });
});

describe("undo bar countdown", () => {
  test("seconds left round up and never go negative", () => {
    const runAt = "2026-09-16T10:00:30.000Z";
    expect(secondsLeft(runAt, new Date("2026-09-16T10:00:00.000Z"))).toBe(30);
    expect(secondsLeft(runAt, new Date("2026-09-16T10:00:29.100Z"))).toBe(1);
    expect(secondsLeft(runAt, new Date("2026-09-16T10:00:31.000Z"))).toBe(0);
    expect(isLater(runAt, new Date("2026-09-16T10:00:00.000Z"))).toBe(false);
    expect(isLater("2026-09-16T14:00:00.000Z", new Date("2026-09-16T10:00:00.000Z"))).toBe(true);
  });
});

describe("the fixture composer", () => {
  test("send schedules with the delay, undo cancels and reopens the Draft, later runs on time", async () => {
    let t = Date.parse("2026-09-16T10:00:00Z");
    const composer = fixtureComposer({ now: () => new Date(t), delaySeconds: 30 });
    await composer.save("d1", content());
    const { sendId, runAt } = await composer.send("d1");
    expect(runAt).toBe("2026-09-16T10:00:30.000Z");
    expect(composer.draft("d1")?.status).toBe("scheduled");
    expect(composer.sends()[0]?.status).toBe("scheduled");
    await composer.cancel(sendId);
    expect(composer.draft("d1")?.status).toBe("open");
    expect(composer.sends()[0]?.status).toBe("cancelled");
    const later = await composer.send("d1", { runAt: "2026-09-16T14:00:00.000Z" });
    expect(later.runAt).toBe("2026-09-16T14:00:00.000Z");
    t = Date.parse("2026-09-16T13:00:00Z");
    expect(composer.runDue()).toBe(0);
    t = Date.parse("2026-09-16T14:00:01Z");
    expect(composer.runDue()).toBe(1);
    expect(composer.draft("d1")?.status).toBe("sent");
    expect(composer.drafts()).toHaveLength(0);
  });

  test("upload reports progress and yields an attachment", async () => {
    const composer = fixtureComposer();
    const seen: number[] = [];
    const done = await composer.upload(
      { name: "a.txt", mediaType: "text/plain", bytes: new Uint8Array(3) },
      (f) => seen.push(f),
    );
    expect(seen).toEqual([1]);
    expect(done).toEqual({ blobId: "blob-1", name: "a.txt", size: 3, mediaType: "text/plain" });
  });
});
