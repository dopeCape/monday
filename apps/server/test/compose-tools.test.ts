// The compose tools over the fake ToolHost (ADR 0002): list_drafts and
// read_draft run silently, read_draft and update_draft act on the Draft open
// in the composer when no id is given, update_draft keeps a reply's quote and
// its Undo puts the previous content back, open_draft reaches the Device only
// when one is listening, and draft_message's card carries "Open draft". The
// open Draft reaches the model's system prompt through the turn context.

import { describe, expect, test } from "bun:test";
import type { ApprovalDecision } from "@monday/shared";
import {
  createMemoryActivityLog,
  createToolServer,
  toolCallOf,
} from "../src/intelligence/agent/index.ts";
import { openLines } from "../src/intelligence/agent/session-runtime.ts";
import { createFakeToolHost } from "../src/intelligence/agent/tools/fake-host.ts";

const NOW = new Date("2026-09-17T10:00:00Z");

function setup(listening = false) {
  const host = createFakeToolHost(
    [
      {
        id: "t-aoife",
        subject: "Take-home review",
        from: "Aoife <aoife@example.test>",
        lastActivity: "2026-09-16T10:00:00.000Z",
        section: "needs-reply",
      },
    ],
    { now: () => NOW },
  );
  const activity = createMemoryActivityLog({ now: () => NOW });
  const server = createToolServer({
    host,
    activity,
    now: () => NOW,
    listening: () => listening,
    settings: async () => ({ previewAbove: 10, alwaysAsk: [], searchLimit: 100 }),
  });
  const never = {
    ask: async (): Promise<ApprovalDecision> => {
      throw new Error("asked");
    },
  };
  let seq = 0;
  const call = (name: string, args: unknown, openDraftId: string | null = null) =>
    server.call({ name, args, callId: `c${++seq}`, sessionId: "s1", openDraftId }, never);
  return { host, server, call };
}

describe("the compose tools", () => {
  test("draft_message's card carries Open draft; list_drafts and read_draft run silently", async () => {
    const { call } = setup();
    const drafted = await call("draft_message", {
      kind: "reply",
      thread_id: "t-aoife",
      body: "Thursday works.",
    });
    expect(toolCallOf(drafted.activity).open).toEqual({
      draftId: "draft-1",
      threadId: "t-aoife",
      kind: "reply",
    });
    const listed = await call("list_drafts", {});
    expect(listed.activity.tier).toBe("read-only");
    expect(listed.text).toContain('draft-1: reply, "Re: Take-home review"');
    const read = await call("read_draft", {}, "draft-1");
    expect(read.text).toContain("Thursday works.");
    expect(read.text).toContain("last saved by agent");
  });

  test("update_draft changes the open Draft, keeps the quote, and Undo restores it", async () => {
    const { host, server, call } = setup();
    await call("draft_message", { kind: "new", to: ["kenji@example.test"], body: "Long text." });
    const d = host.drafts.get("draft-1");
    if (!d) throw new Error("no draft");
    host.drafts.set("draft-1", {
      ...d,
      bodyHtml: '<p>Long text.</p><div class="quoted"><p>On Monday, Kenji wrote:</p></div>',
    });
    const updated = await call(
      "update_draft",
      { body: "Short.", subject: "Terms", cc: ["Ravi <ravi@example.test>"] },
      "draft-1",
    );
    expect(updated.isError).toBe(false);
    expect(updated.activity.tier).toBe("reversible");
    const after = host.drafts.get("draft-1");
    expect(after?.subject).toBe("Terms");
    expect(after?.cc).toEqual([{ name: "Ravi", email: "ravi@example.test" }]);
    expect(after?.bodyHtml).toBe(
      '<p>Short.</p><div class="quoted"><p>On Monday, Kenji wrote:</p></div>',
    );
    expect(after?.bodyText).toBe("Short.\n\nOn Monday, Kenji wrote:");
    expect(toolCallOf(updated.activity).open?.draftId).toBe("draft-1");
    await server.undo(updated.activity.id, "s1");
    expect(host.drafts.get("draft-1")?.subject).toBe("");
    expect(host.drafts.get("draft-1")?.bodyText).toBe("Long text.");
  });

  test("without an id and nothing open, the tools say what to do", async () => {
    const { call } = setup();
    const read = await call("read_draft", {});
    expect(read.isError).toBe(true);
    expect(read.text).toContain("list_drafts");
  });

  test("open_draft reaches a listening Device through the card, and says so when none is", async () => {
    const quiet = setup(false);
    await quiet.call("draft_message", { kind: "new", body: "Hi" });
    const none = await quiet.call("open_draft", { draft_id: "draft-1" });
    expect(none.text).toContain("No Device is following");
    expect(toolCallOf(none.activity).open).toBeUndefined();
    const live = setup(true);
    await live.call("draft_message", { kind: "new", body: "Hi" });
    const opened = await live.call("open_draft", { draft_id: "draft-1" });
    expect(opened.activity.tier).toBe("read-only");
    expect(toolCallOf(opened.activity).open).toEqual({
      draftId: "draft-1",
      threadId: null,
      kind: "new",
    });
  });

  test("the turn context's open Draft and Thread reach the system prompt", () => {
    expect(openLines({})).toBe("");
    const lines = openLines({ threadId: "t1", draftId: "d1" });
    expect(lines).toContain("The reader shows Thread t1.");
    expect(lines).toContain("The composer has Draft d1 open.");
  });
});
