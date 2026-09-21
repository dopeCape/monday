// Action chips as tool calls (slice 13): every BriefAction names a tool with
// its Tier, and the runner over InboxActions keeps ADR 0002 (a reply chip
// opens compose and never sends; snooze and archive come back with Undo).

import { describe, expect, test } from "bun:test";
import type { BriefAction, ThreadJudgments } from "@monday/shared";
import { fixtureInbox } from "./actions.ts";
import { createActionRunner, judgedChips, tierOf, toolCallOf } from "./brief-actions.ts";

const priya = { name: "Priya Raman", email: "priya@raman.test" };
const actions: Record<BriefAction["kind"], BriefAction> = {
  reply: { kind: "reply", label: "Say yes", proposedLine: "Thursday works for me." },
  forward: { kind: "forward", label: "Forward to Priya", to: priya },
  calendar: {
    kind: "calendar",
    label: "Add to calendar",
    eventTitle: "Take-home call",
    start: "2026-09-18T15:00:00+02:00",
  },
  snooze: { kind: "snooze", label: "Friday", until: "2026-09-18T09:00:00.000Z" },
  archive: { kind: "archive", label: "Archive" },
  "open-link": { kind: "open-link", label: "Open PR", url: "https://github.test/pr/142" },
  call: { kind: "call", label: "Set up a call" },
  "open-attachment": { kind: "open-attachment", label: "Open the attachment", attachmentId: "a1" },
  "pay-or-file": { kind: "pay-or-file", label: "Pay or file" },
};

describe("toolCallOf", () => {
  test("maps every chip kind to a tool, its arguments and its Tier", () => {
    expect(toolCallOf(actions.reply, "t1")).toEqual({
      tool: "compose.reply",
      tier: "always-ask",
      args: { threadId: "t1", opening: "Thursday works for me." },
    });
    expect(toolCallOf(actions.forward, "t1")).toEqual({
      tool: "compose.forward",
      tier: "always-ask",
      args: { threadId: "t1", to: priya },
    });
    expect(toolCallOf(actions.calendar, "t1")).toEqual({
      tool: "calendar.create_event",
      tier: "always-ask",
      args: { threadId: "t1", title: "Take-home call", start: "2026-09-18T15:00:00+02:00" },
    });
    expect(toolCallOf(actions.snooze, "t1")).toEqual({
      tool: "thread.snooze",
      tier: "reversible",
      args: { threadId: "t1", until: "2026-09-18T09:00:00.000Z" },
    });
    expect(toolCallOf(actions.archive, "t1")).toEqual({
      tool: "thread.archive",
      tier: "reversible",
      args: { threadId: "t1" },
    });
    expect(toolCallOf(actions["open-link"], "t1")).toEqual({
      tool: "open.link",
      tier: "read-only",
      args: { url: "https://github.test/pr/142" },
    });
    // The judged chips (slice 25): a call or pay-or-file is a sentence for the agent bar, an attachment opens.
    expect(toolCallOf(actions.call, "t1")).toEqual({
      tool: "agent.ask",
      tier: "read-only",
      args: { threadId: "t1", intent: "call" },
    });
    expect(toolCallOf(actions["pay-or-file"], "t1")).toEqual({
      tool: "agent.ask",
      tier: "read-only",
      args: { threadId: "t1", intent: "pay-or-file" },
    });
    expect(toolCallOf(actions["open-attachment"], "t1")).toEqual({
      tool: "open.attachment",
      tier: "read-only",
      args: { attachmentId: "a1" },
    });
    // Leaving the mailbox always asks; nothing is ever demoted (ADR 0002).
    expect(["reply", "forward", "calendar"].map((k) => tierOf(actions[k as "reply"]))).toEqual([
      "always-ask",
      "always-ask",
      "always-ask",
    ]);
  });
});

describe("judgedChips", () => {
  const judgments: ThreadJudgments = {
    threadId: "t1",
    needsReply: 0.64,
    waitingOnOthers: 0.2,
    newsletter: 0.07,
    automated: 0.05,
    briefWorth: 1,
    urgency: 1.2,
    chips: {
      reply: 0.84,
      call: 0.86,
      review_link: 0.7,
      open_attachment: 0.74,
      pay_or_file: 0.1,
      snooze: 0.61,
    },
    model: "jev-1.13.0",
    judgedAt: "2026-09-21T09:00:00.000Z",
  };
  const labels = {
    reply: "Reply",
    call: "Set up a call",
    review_link: "Review the link",
    open_attachment: "Open the attachment",
    pay_or_file: "Pay or file",
    snooze: "Snooze",
  };

  test("chips above the threshold, likeliest first, at most the cap; a chip missing its link or attachment is skipped", () => {
    const chips = judgedChips(judgments, {
      threshold: 0.6,
      max: 3,
      labels,
      link: "https://github.test/pr/142",
      attachmentId: "a1",
      snoozeUntil: "2026-09-22T08:00:00.000Z",
    });
    expect(chips).toEqual([
      { kind: "call", label: "Set up a call" },
      { kind: "reply", label: "Reply", proposedLine: "" },
      { kind: "open-attachment", label: "Open the attachment", attachmentId: "a1" },
    ]);
    // No link and no attachment on the Thread: those chips give way to the next.
    expect(
      judgedChips(judgments, {
        threshold: 0.6,
        max: 5,
        labels,
        link: null,
        attachmentId: null,
        snoozeUntil: "2026-09-22T08:00:00.000Z",
      }).map((c) => c.kind),
    ).toEqual(["call", "reply", "snooze"]);
    // A higher threshold shows fewer; every chip is a BriefAction the runner already knows.
    expect(
      judgedChips(judgments, {
        threshold: 0.85,
        max: 3,
        labels,
        link: null,
        attachmentId: null,
        snoozeUntil: null,
      }),
    ).toEqual([{ kind: "call", label: "Set up a call" }]);
  });
});

describe("the runner over InboxActions and compose", () => {
  const setup = () => {
    const inbox = fixtureInbox();
    const composed: Array<{ kind: string; threadId: string; seed: unknown }> = [];
    const opened: string[] = [];
    const runner = createActionRunner({
      inbox,
      compose: (kind, threadId, seed) => composed.push({ kind, threadId, seed }),
      openLink: (url) => {
        opened.push(url);
      },
    });
    return { inbox, composed, opened, runner };
  };

  test("a reply chip opens compose seeded with the line; a forward chip with the person; neither sends", async () => {
    const { runner, composed } = setup();
    const reply = await runner.run(actions.reply, "e1");
    expect(reply).toMatchObject({ ok: true, undo: null, call: { tool: "compose.reply" } });
    const forward = await runner.run(actions.forward, "e1");
    expect(forward).toMatchObject({ ok: true, undo: null });
    expect(composed).toEqual([
      { kind: "reply", threadId: "e1", seed: { opening: "Thursday works for me." } },
      { kind: "forward", threadId: "e1", seed: { to: [priya] } },
    ]);
  });

  test("snooze and archive apply through InboxActions and come back with Undo", async () => {
    const { runner, inbox } = setup();
    const snoozed = await runner.run(actions.snooze, "e1");
    expect(snoozed.ok).toBe(true);
    expect(inbox.thread("e1")?.snoozedUntil).toBe("2026-09-18T09:00:00.000Z");
    if (snoozed.ok && snoozed.undo) await inbox.undo(snoozed.undo);
    expect(inbox.thread("e1")?.snoozedUntil).toBeNull();

    const archived = await runner.run(actions.archive, "e2");
    expect(inbox.thread("e2")?.archived).toBe(true);
    if (archived.ok && archived.undo) await inbox.undo(archived.undo);
    expect(inbox.thread("e2")?.archived).toBe(false);

    const bad = await runner.run({ ...actions.snooze, until: "not a date" } as BriefAction, "e1");
    expect(bad).toMatchObject({ ok: false, reason: "unavailable" });
  });

  test("a call or pay-or-file chip hands the agent bar a sentence; an attachment chip opens it; without those seams they report unavailable", async () => {
    const { runner } = setup();
    expect(await runner.run(actions.call, "e1")).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(await runner.run(actions["open-attachment"], "e1")).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    const asked: string[] = [];
    const openedAttachments: string[] = [];
    const full = createActionRunner({
      inbox: fixtureInbox(),
      compose: () => {},
      openLink: () => {},
      ask: (threadId, intent) => asked.push(`${threadId}:${intent}`),
      openAttachment: (id) => {
        openedAttachments.push(id);
      },
    });
    expect((await full.run(actions.call, "e1")).ok).toBe(true);
    expect((await full.run(actions["pay-or-file"], "e2")).ok).toBe(true);
    expect((await full.run(actions["open-attachment"], "e1")).ok).toBe(true);
    expect(asked).toEqual(["e1:call", "e2:pay-or-file"]);
    expect(openedAttachments).toEqual(["a1"]);
  });

  test("a link opens outside; a calendar chip reports the calendar is not connected until slice 18", async () => {
    const { runner, opened } = setup();
    expect((await runner.run(actions["open-link"], "e1")).ok).toBe(true);
    expect(opened).toEqual(["https://github.test/pr/142"]);
    expect(await runner.run(actions.calendar, "e1")).toMatchObject({
      ok: false,
      reason: "calendar_unavailable",
    });
    const events: unknown[] = [];
    const withCalendar = createActionRunner({
      inbox: fixtureInbox(),
      compose: () => {},
      openLink: () => {},
      calendar: async (event) => {
        events.push(event);
      },
    });
    expect((await withCalendar.run(actions.calendar, "e1")).ok).toBe(true);
    expect(events).toEqual([
      { threadId: "e1", title: "Take-home call", start: "2026-09-18T15:00:00+02:00" },
    ]);
  });
});
