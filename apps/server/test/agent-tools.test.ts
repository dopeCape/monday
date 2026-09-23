// The tool server and the LangGraph loop through their interfaces over the
// fakes at every seam (ADR 0002, ADR 0007): tiers and approvals inside the
// tools, the preview threshold, the ledger that keeps a re-executed node
// from applying twice, Undo, the Settings tool against a pinned key, and a
// scripted model driving the loop end to end without a network or Postgres.

import { describe, expect, test } from "bun:test";
import {
  type AgentEvent,
  type ApprovalDecision,
  TOOL_TIERS,
  type ToolPreview,
} from "@monday/shared";
import {
  createAgentHost,
  createMemoryActivityLog,
  createMemorySessionStore,
  createToolServer,
  TOOL_CATALOG,
} from "../src/intelligence/agent/index.ts";
import {
  createFakeToolHost,
  type FakeThreadInput,
} from "../src/intelligence/agent/tools/fake-host.ts";
import { createFakeRuntime, type FakeStep } from "../src/intelligence/runtime/fake/index.ts";
import type { AgentMessage } from "../src/intelligence/runtime/index.ts";

const NOW = new Date("2026-09-17T10:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

/** Twelve newsletters older than a week, two fresh ones, and some other mail. */
function fixtureMailbox(): FakeThreadInput[] {
  const old = Array.from({ length: 12 }, (_, i) => ({
    id: `nl-old-${i + 1}`,
    subject: `Weekly digest ${i + 1}`,
    from: "digest@newsletter.test",
    lastActivity: daysAgo(8 + i),
    section: "newsletters",
  }));
  const fresh = [1, 2].map((i) => ({
    id: `nl-new-${i}`,
    subject: `This week ${i}`,
    from: "digest@newsletter.test",
    lastActivity: daysAgo(i),
    section: "newsletters",
  }));
  const other = [
    {
      id: "t-aoife",
      subject: "Take-home review",
      from: "Aoife <aoife@example.test>",
      lastActivity: daysAgo(1),
      section: "needs-reply",
      unread: true,
    },
    {
      id: "t-old-reply",
      subject: "Old question",
      from: "kenji@example.test",
      lastActivity: daysAgo(30),
      section: "needs-reply",
    },
  ];
  return [...old, ...fresh, ...other];
}

const settings = { previewAbove: 10, alwaysAsk: [] as string[], searchLimit: 100 };

function toolServerOverFakes(seed = fixtureMailbox(), over: Partial<typeof settings> = {}) {
  const host = createFakeToolHost(seed, { now: () => NOW });
  const activity = createMemoryActivityLog({ now: () => NOW });
  const server = createToolServer({
    host,
    activity,
    now: () => NOW,
    settings: async () => ({ ...settings, ...over }),
  });
  return { host, activity, server };
}

/** An approver that records what it was asked and answers from a list. */
function approver(...answers: ApprovalDecision[]) {
  const asked: ToolPreview[] = [];
  return {
    asked,
    ask: async (_row: unknown, preview: ToolPreview) => {
      asked.push(preview);
      const next = answers.shift();
      if (!next) throw new Error("asked more than scripted");
      return next;
    },
  };
}

describe("the tool catalog", () => {
  test("every tool declares a tier and the MCP listing carries it", () => {
    const { server } = toolServerOverFakes();
    const tiers = Object.fromEntries(TOOL_CATALOG.map((t) => [t.name, t.tier]));
    expect(tiers).toEqual({
      search_threads: "read",
      read_thread: "read",
      list_groups_and_sections: "read",
      archive_threads: "reversible",
      snooze_threads: "reversible",
      tag_threads: "reversible",
      move_threads: "reversible",
      draft_message: "reversible",
      change_setting: "reversible",
      change_layout: "reversible",
      trash_threads: "destructive",
      send_draft: "leaves_mailbox",
      forward_thread: "leaves_mailbox",
      undo: "read",
      // Slice 16: the integrations, MCP servers and the Workflow tools.
      post_to_slack: "leaves_mailbox",
      post_to_discord: "leaves_mailbox",
      add_notion_row: "leaves_mailbox",
      save_to_drive: "leaves_mailbox",
      call_webhook: "leaves_mailbox",
      call_mcp_tool: "leaves_mailbox",
      list_workflows: "read",
      create_workflow: "reversible",
      update_workflow: "reversible",
      enable_workflow: "reversible",
      dry_run_workflow: "read",
      list_workflow_runs: "read",
      approve_workflow_step: "leaves_mailbox",
      run_workflow: "reversible",
      // Slice 19: an external key the Agent makes; revoking it is the undo.
      create_external_key: "reversible",
      build_voice_profile: "reversible",
      // Slice 20: onboarding.
      onboarding_context: "read",
      propose_groups: "reversible",
      propose_workflows: "read",
      adopt_workflow: "reversible",
      propose_views: "reversible",
      set_keymap: "reversible",
      list_events: "read",
      schedule_event: "leaves_mailbox",
      rsvp: "leaves_mailbox",
      update_event: "leaves_mailbox",
      delete_event: "destructive",
      // Slice 26: Sections, Groups and custom actions from a sentence; every one reversible.
      create_section: "reversible",
      update_section: "reversible",
      delete_section: "reversible",
      create_action: "reversible",
      update_action: "reversible",
      delete_action: "reversible",
      create_group: "reversible",
      update_group: "reversible",
      organize_existing: "reversible",
      explain_placement: "read",
      list_judgments: "read",
      test_judgment: "read",
      update_judgment: "reversible",
      add_example: "reversible",
    });
    // The shared list the Settings screens render the Permissions tiers from matches the catalog.
    expect(tiers).toEqual(TOOL_TIERS);
    const mcp = server.mcpTools();
    expect(mcp.map((t) => t.name)).toEqual(TOOL_CATALOG.map((t) => t.name));
    const send = mcp.find((t) => t.name === "send_draft");
    expect(send?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(send?.inputSchema).toMatchObject({ type: "object", required: ["draft_id"] });
    const search = mcp.find((t) => t.name === "search_threads");
    expect(search?.annotations?.readOnlyHint).toBe(true);
    // The model sees the same schemas through the runtime's ToolSpec shape.
    expect(server.specs().map((s) => s.name)).toEqual(mcp.map((t) => t.name));
  });

  test("a read tool runs silently and lands in the Activity log as auto", async () => {
    const { server, activity } = toolServerOverFakes();
    const a = approver();
    const outcome = await server.call(
      {
        name: "search_threads",
        args: { section: "newsletters", older_than_days: 7 },
        callId: "c1",
        sessionId: "s1",
      },
      a,
    );
    expect(outcome.isError).toBe(false);
    expect(a.asked).toHaveLength(0);
    expect(outcome.text.startsWith("12 threads:")).toBe(true);
    expect(activity.rows).toHaveLength(1);
    expect(activity.rows[0]).toMatchObject({
      tool: "search_threads",
      tier: "read-only",
      status: "done",
      decision: "auto",
      inputSummary: "section:newsletters · older than 7 days",
      undoable: false,
    });
  });

  test("a reversible batch under the threshold applies at once with an undo record", async () => {
    const { server, host } = toolServerOverFakes();
    const a = approver();
    const outcome = await server.call(
      {
        name: "archive_threads",
        args: { thread_ids: ["nl-old-1", "nl-old-2", "missing"] },
        callId: "c2",
        sessionId: "s1",
      },
      a,
    );
    expect(a.asked).toHaveLength(0);
    expect(outcome.text).toBe("Archive: 2 threads (1 id not found).");
    expect(host.threads.get("nl-old-1")?.archived).toBe(true);
    expect(outcome.activity).toMatchObject({ status: "done", decision: "auto", undoable: true });
    expect(outcome.activity.undo).toEqual({
      kind: "intents",
      intents: [
        { kind: "unarchive", threadId: "nl-old-1" },
        { kind: "unarchive", threadId: "nl-old-2" },
      ],
    });
    // The Agent's own writes are automation, so a later manual action beats them.
    expect(host.intents.every((i) => i.actor === "automation")).toBe(true);
  });

  test("a reversible batch above the threshold previews first and applies on approval", async () => {
    const { server, host } = toolServerOverFakes();
    const ids = Array.from({ length: 12 }, (_, i) => `nl-old-${i + 1}`);
    const a = approver("approved");
    const outcome = await server.call(
      { name: "archive_threads", args: { thread_ids: ids }, callId: "c3", sessionId: "s1" },
      a,
    );
    expect(a.asked).toHaveLength(1);
    expect(a.asked[0]).toMatchObject({ kind: "threads", action: "Archive", count: 12 });
    expect((a.asked[0] as { threads: unknown[] }).threads).toHaveLength(12);
    expect(outcome.activity).toMatchObject({
      status: "done",
      decision: "approved",
      approvedBy: "user",
    });
    expect(ids.every((id) => host.threads.get(id)?.archived)).toBe(true);
  });

  test("the threshold is the Setting: with preview_above 1 even a pair previews", async () => {
    const { server } = toolServerOverFakes(undefined, { previewAbove: 1 });
    const a = approver("approved");
    await server.call(
      {
        name: "archive_threads",
        args: { thread_ids: ["nl-old-1", "nl-old-2"] },
        callId: "c4",
        sessionId: "s1",
      },
      a,
    );
    expect(a.asked).toHaveLength(1);
  });

  test("a declined preview changes nothing and the decline is recorded", async () => {
    const { server, host, activity } = toolServerOverFakes();
    const ids = Array.from({ length: 12 }, (_, i) => `nl-old-${i + 1}`);
    const a = approver("declined");
    const outcome = await server.call(
      { name: "archive_threads", args: { thread_ids: ids }, callId: "c5", sessionId: "s1" },
      a,
    );
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain("Declined by the user");
    expect(host.intents).toHaveLength(0);
    expect(ids.every((id) => host.threads.get(id)?.archived === false)).toBe(true);
    expect(activity.rows[0]).toMatchObject({
      status: "done",
      decision: "declined",
      undoable: false,
    });
    expect(await activity.latestUndoable("ws-fake")).toBeNull();
  });

  test("a send asks even for one message and shows the exact payload", async () => {
    const { server, host } = toolServerOverFakes();
    const none = approver();
    const drafted = await server.call(
      {
        name: "draft_message",
        args: { kind: "reply", thread_id: "t-aoife", body: "Thursday 15:00 works for me." },
        callId: "c6",
        sessionId: "s1",
      },
      none,
    );
    expect(none.asked).toHaveLength(0);
    expect(drafted.activity.undo).toEqual({ kind: "draft", draftId: "draft-1" });
    const draft = host.drafts.get("draft-1");
    expect(draft).toMatchObject({
      kind: "reply",
      subject: "Re: Take-home review",
      to: [{ name: "", email: "aoife@example.test" }],
      inReplyToMessageId: "t-aoife-m1",
    });

    const a = approver("approved");
    const sent = await server.call(
      { name: "send_draft", args: { draft_id: "draft-1" }, callId: "c7", sessionId: "s1" },
      a,
    );
    expect(a.asked).toEqual([
      {
        kind: "send",
        to: [{ name: "", email: "aoife@example.test" }],
        cc: [],
        subject: "Re: Take-home review",
        text: "Thursday 15:00 works for me.",
      },
    ]);
    expect(sent.activity).toMatchObject({
      tier: "always-ask",
      status: "done",
      decision: "approved",
    });
    expect(host.sends.size).toBe(1);
    expect(sent.activity.undo).toEqual({ kind: "send", sendId: "send-2" });

    // Undo within the window cancels the Job and reopens the Draft.
    const undone = await server.undo(sent.activity.id, "s1");
    expect(undone.text).toContain("cancelled");
    expect(host.sends.get("send-2")?.cancelled).toBe(true);
    expect(host.drafts.get("draft-1")?.status).toBe("open");
  });

  test("forward and trash ask first; a tool promoted to always-ask asks too", async () => {
    const { server, host } = toolServerOverFakes(undefined, { alwaysAsk: ["archive_threads"] });
    const a = approver("approved", "declined", "approved");
    const fwd = await server.call(
      {
        name: "forward_thread",
        args: { thread_id: "t-aoife", to: ["Kenji <kenji@example.test>"], note: "FYI" },
        callId: "f1",
        sessionId: "s1",
      },
      a,
    );
    expect(a.asked[0]).toMatchObject({
      kind: "send",
      to: [{ name: "Kenji", email: "kenji@example.test" }],
      subject: "Fwd: Take-home review",
    });
    expect(
      (a.asked[0] as { text: string }).text.startsWith("FYI\n\n---------- Forwarded message"),
    ).toBe(true);
    expect(fwd.activity.status).toBe("done");
    expect(host.sends.size).toBe(1);

    const trash = await server.call(
      {
        name: "trash_threads",
        args: { thread_ids: ["t-old-reply"] },
        callId: "f2",
        sessionId: "s1",
      },
      a,
    );
    expect(trash.activity.decision).toBe("declined");
    expect(host.threads.get("t-old-reply")?.deleted).toBe(false);

    const one = await server.call(
      {
        name: "archive_threads",
        args: { thread_ids: ["nl-old-1"] },
        callId: "f3",
        sessionId: "s1",
      },
      a,
    );
    expect(one.activity.tier).toBe("always-ask");
    expect(a.asked).toHaveLength(3);
    expect(await server.tierOf("archive_threads")).toBe("always-ask");
    expect(await server.tierOf("search_threads")).toBe("read-only");
  });

  test("a settings change validates through the schema, applies with undo, and a pinned key is refused with the reason", async () => {
    const { server, host } = toolServerOverFakes();
    const a = approver();
    const bad = await server.call(
      {
        name: "change_setting",
        args: { key: "appearance.density", value: "huge" },
        callId: "s1",
        sessionId: "s1",
      },
      a,
    );
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("appearance.density");
    expect(host.writes).toHaveLength(0);

    const unknown = await server.call(
      {
        name: "change_setting",
        args: { key: "appearance.nope", value: 1 },
        callId: "s2",
        sessionId: "s1",
      },
      a,
    );
    expect(unknown.text).toBe('Unknown setting "appearance.nope".');

    const good = await server.call(
      {
        name: "change_setting",
        args: { key: "appearance.palette", value: "gruvbox" },
        callId: "s3",
        sessionId: "s1",
      },
      a,
    );
    expect(good.isError).toBe(false);
    expect(host.writes).toEqual([{ key: "appearance.palette", value: "gruvbox" }]);
    expect(good.activity.preview).toEqual({
      kind: "setting",
      key: "appearance.palette",
      from: "graphite",
      to: "gruvbox",
    });
    expect(good.activity.undo).toEqual({
      kind: "settings",
      entries: [{ key: "appearance.palette", previous: "graphite" }],
    });

    // The Device says the key is pinned: refused, and the reason names the file.
    const pinned = await server.call(
      {
        name: "change_setting",
        args: { key: "appearance.mode", value: "dark" },
        callId: "s4",
        sessionId: "s1",
        pinned: ["appearance.mode"],
      },
      a,
    );
    expect(pinned.isError).toBe(true);
    expect(pinned.text).toContain("appearance.mode is set in monday.toml");
    expect(host.writes).toHaveLength(1);

    const layout = await server.call(
      {
        name: "change_layout",
        args: { nav: "hidden", agent: "right" },
        callId: "s5",
        sessionId: "s1",
      },
      a,
    );
    expect(layout.isError).toBe(false);
    expect(host.settings.get("layout.nav")).toBe("hidden");
    expect(host.settings.get("layout.agent")).toBe("right");
    const undone = await server.undo(layout.activity.id, "s1");
    expect(undone.isError).toBe(false);
    expect(host.settings.get("layout.nav")).toBe("full");
    expect(host.settings.get("layout.agent")).toBe("bottom");
  });

  test("the undo tool reverses the Session's last reversible action as the user", async () => {
    const { server, host } = toolServerOverFakes();
    const a = approver();
    await server.call(
      {
        name: "archive_threads",
        args: { thread_ids: ["nl-old-1"] },
        callId: "u1",
        sessionId: "s1",
      },
      a,
    );
    await server.call({ name: "search_threads", args: {}, callId: "u2", sessionId: "s1" }, a);
    const undo = await server.call({ name: "undo", args: {}, callId: "u3", sessionId: "s1" }, a);
    expect(undo.text).toBe("Undone: 1 of 1 thread restored.");
    expect(host.threads.get("nl-old-1")?.archived).toBe(false);
    expect(host.intents.at(-1)).toMatchObject({
      kind: "unarchive",
      threadId: "nl-old-1",
      actor: "user",
    });
    const again = await server.call({ name: "undo", args: {}, callId: "u4", sessionId: "s1" }, a);
    expect(again.text).toBe("Nothing to undo.");
  });

  test("the ledger answers a finished call id without running it again", async () => {
    const { server, host } = toolServerOverFakes();
    const a = approver();
    const first = await server.call(
      {
        name: "archive_threads",
        args: { thread_ids: ["nl-old-1"] },
        callId: "same",
        sessionId: "s1",
      },
      a,
    );
    await host.applyIntents([{ kind: "unarchive", threadId: "nl-old-1" }], { actor: "user" });
    const second = await server.call(
      {
        name: "archive_threads",
        args: { thread_ids: ["nl-old-1"] },
        callId: "same",
        sessionId: "s1",
      },
      a,
    );
    expect(second.activity.id).toBe(first.activity.id);
    expect(second.text).toBe(first.text);
    expect(host.threads.get("nl-old-1")?.archived).toBe(false);
  });

  test("unknown tools and bad input fail the call without touching anything", async () => {
    const { server, host } = toolServerOverFakes();
    const a = approver();
    const unknown = await server.call(
      { name: "launch_missiles", args: {}, callId: "x1", sessionId: "s1" },
      a,
    );
    expect(unknown).toMatchObject({ isError: true, text: 'Unknown tool "launch_missiles".' });
    const bad = await server.call(
      { name: "snooze_threads", args: { thread_ids: [] }, callId: "x2", sessionId: "s1" },
      a,
    );
    expect(bad.isError).toBe(true);
    expect(bad.text.startsWith("Invalid input:")).toBe(true);
    expect(host.intents).toHaveLength(0);
  });
});

/* ------------------------------ The loop ------------------------------ */

const toolMessageIds = (messages: AgentMessage[], name: string): string[] => {
  const tool = [...messages].reverse().find((m) => m.role === "tool" && m.name === name);
  if (tool?.role !== "tool") return [];
  const json = tool.content.slice(tool.content.indexOf("["));
  return (JSON.parse(json) as Array<{ id: string }>).map((t) => t.id);
};

function loopOverFakes(
  steps: FakeStep[],
  over: Partial<typeof settings & { maxSteps: number }> = {},
) {
  const { runtime, converse, meter } = createFakeRuntime({ steps, now: () => NOW.getTime() });
  const host = createFakeToolHost(fixtureMailbox(), { now: () => NOW });
  const activity = createMemoryActivityLog({ now: () => NOW });
  const sessions = createMemorySessionStore({ now: () => NOW });
  const agent = createAgentHost({
    runtime,
    activity,
    sessions,
    hostFor: () => host,
    now: () => NOW,
    workspaceAddress: async () => "me@example.test",
    settings: async () => ({
      systemPrompt: "You are monday.",
      maxSteps: 24,
      ...settings,
      ...over,
    }),
  });
  return { agent, host, activity, sessions, converse, meter };
}

describe("the LangGraph loop over the fakes", () => {
  test("archive every newsletter older than a week: previews above 10, applies on approval, Undo restores every thread", async () => {
    const { agent, host, activity, sessions, converse, meter } = loopOverFakes([
      {
        text: "Looking for old newsletters.",
        toolCalls: [
          {
            id: "call-1",
            name: "search_threads",
            args: { section: "newsletters", older_than_days: 7 },
          },
        ],
      },
      (call) => ({
        toolCalls: [
          {
            id: "call-2",
            name: "archive_threads",
            args: { thread_ids: toolMessageIds(call.messages, "search_threads") },
          },
        ],
      }),
      "Archived 12 newsletters older than a week.",
    ]);
    const session = await agent.createSession("ws-fake");
    expect(session.runtime).toEqual({
      kind: "hosted",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });

    const events: AgentEvent[] = [];
    const first = await agent.turn(
      session.id,
      "archive every newsletter older than a week",
      {},
      (e) => events.push(e),
    );

    // The turn paused at the preview: 12 Threads is above the threshold of 10.
    expect(first.waiting).not.toBeNull();
    const waiting = events.filter((e) => e.kind === "tool" && e.call.status === "waiting");
    expect(waiting).toHaveLength(1);
    const card = waiting[0];
    if (card?.kind !== "tool") throw new Error("no waiting card");
    expect(card.call.tool).toBe("archive_threads");
    expect(card.call.tier).toBe("reversible");
    expect(card.preview).toMatchObject({ kind: "threads", action: "Archive", count: 12 });
    expect(card.call.id).toBe(first.waiting as string);
    expect(events.at(-1)).toMatchObject({ kind: "done", waiting: first.waiting });
    expect(host.intents).toHaveLength(0);
    // Text streamed before the answer landed.
    expect(
      events
        .filter((e) => e.kind === "delta")
        .map((e) => (e as { text: string }).text)
        .join(""),
    ).toBe("Looking for old newsletters.");
    expect(events.some((e) => e.kind === "text" && e.text === "Looking for old newsletters.")).toBe(
      true,
    );

    // Approve: the tools node re-executes, the search answers from the ledger, the archive applies.
    const more: AgentEvent[] = [];
    const second = await agent.resume(session.id, card.call.id, "approved", {}, (e) =>
      more.push(e),
    );
    expect(second.waiting).toBeNull();
    const oldIds = Array.from({ length: 12 }, (_, i) => `nl-old-${i + 1}`);
    expect(oldIds.every((id) => host.threads.get(id)?.archived)).toBe(true);
    expect(host.threads.get("nl-new-1")?.archived).toBe(false);
    expect(host.intents.filter((i) => i.kind === "archive")).toHaveLength(12);
    expect(
      more.some(
        (e) => e.kind === "text" && e.text === "Archived 12 newsletters older than a week.",
      ),
    ).toBe(true);
    // Three model calls, each metered under the composer Task.
    expect(converse.calls).toHaveLength(3);
    expect(meter.rows.map((r) => r.task)).toEqual(["composer", "composer", "composer"]);

    // The Activity log shows the call with its tier, preview, decision and result.
    const log = await agent.listActivity("ws-fake");
    const archive = log.find((r) => r.tool === "archive_threads");
    expect(archive).toMatchObject({
      tier: "reversible",
      status: "done",
      decision: "approved",
      approvedBy: "user",
      undoable: true,
      inputSummary: "12 threads",
      result: "Archive: 12 threads.",
    });
    expect(archive?.preview).toMatchObject({ kind: "threads", count: 12 });
    expect(log.find((r) => r.tool === "search_threads")).toMatchObject({
      tier: "read-only",
      decision: "auto",
    });

    // Undo from the card restores every one of them, as the user.
    const undone = await agent.undo(archive?.id as string, session.id);
    expect(undone.status).toBe("done");
    expect(undone.result).toBe("Undone: 12 of 12 threads restored.");
    expect(oldIds.every((id) => host.threads.get(id)?.archived === false)).toBe(true);
    expect(host.intents.filter((i) => i.kind === "unarchive" && i.actor === "user")).toHaveLength(
      12,
    );
    expect((await agent.listActivity("ws-fake")).find((r) => r.id === archive?.id)).toMatchObject({
      undoable: false,
    });
    expect(activity.rows.find((r) => r.id === archive?.id)?.undoneAt).toBe(NOW.toISOString());

    // The transcript replays the user turn, the answers and one card per call in its final state.
    const transcript = (await agent.getSession(session.id))?.events ?? [];
    expect(transcript.map((e) => e.kind)).toEqual([
      "user",
      "text",
      "tool",
      "tool",
      "done",
      "text",
      "done",
      "tool",
    ]);
    const replayed = transcript.find((e) => e.kind === "tool" && e.call.tool === "archive_threads");
    expect(replayed && replayed.kind === "tool" ? replayed.call.undoneAt : null).toBe(
      NOW.toISOString(),
    );
    expect((await sessions.list("ws-fake"))[0]?.title).toBe(
      "archive every newsletter older than a week",
    );
  });

  test("a declined preview leaves the mailbox alone and the model hears the decline", async () => {
    const { agent, host, converse } = loopOverFakes([
      {
        toolCalls: [
          {
            id: "d1",
            name: "search_threads",
            args: { section: "newsletters", older_than_days: 7 },
          },
        ],
      },
      (call) => ({
        toolCalls: [
          {
            id: "d2",
            name: "archive_threads",
            args: { thread_ids: toolMessageIds(call.messages, "search_threads") },
          },
        ],
      }),
      "Understood, I left them alone.",
    ]);
    const session = await agent.createSession("ws-fake");
    const events: AgentEvent[] = [];
    const first = await agent.turn(session.id, "archive old newsletters", {}, (e) =>
      events.push(e),
    );
    await agent.resume(session.id, first.waiting as string, "declined", {}, (e) => events.push(e));
    expect(host.intents).toHaveLength(0);
    const last = converse.calls.at(-1)?.messages.at(-1);
    expect(last?.role === "tool" ? last.content : "").toContain("Declined by the user");
    const card = [...events]
      .reverse()
      .find((e) => e.kind === "tool" && e.call.tool === "archive_threads");
    expect(card && card.kind === "tool" ? card.call : null).toMatchObject({
      status: "done",
      approvedBy: null,
      undoable: false,
    });
  });

  test("a pinned key from the Device is refused inside the tool and the model is told why", async () => {
    const { agent, host, converse } = loopOverFakes([
      {
        toolCalls: [
          { id: "p1", name: "change_setting", args: { key: "appearance.mode", value: "dark" } },
        ],
      },
      "That key is pinned in your monday.toml, so I left it.",
    ]);
    const session = await agent.createSession("ws-fake");
    const events: AgentEvent[] = [];
    const result = await agent.turn(
      session.id,
      "switch to dark",
      { pinned: ["appearance.mode"] },
      (e) => events.push(e),
    );
    expect(result.waiting).toBeNull();
    expect(host.writes).toHaveLength(0);
    const last = converse.calls.at(-1)?.messages.at(-1);
    expect(last?.role === "tool" ? last : null).toMatchObject({ isError: true });
    expect(last?.role === "tool" ? last.content : "").toContain(
      "appearance.mode is set in monday.toml",
    );
    const card = [...events].reverse().find((e) => e.kind === "tool");
    expect(card && card.kind === "tool" ? card.call.status : null).toBe("failed");
  });

  test("a missing provider key ends the turn with an error event, not a crash", async () => {
    const { runtime } = createFakeRuntime({ keys: {} });
    const agent = createAgentHost({
      runtime,
      activity: createMemoryActivityLog(),
      sessions: createMemorySessionStore(),
      hostFor: () => createFakeToolHost(),
      workspaceAddress: async () => "me@example.test",
      settings: async () => ({ systemPrompt: "", maxSteps: 3, ...settings }),
    });
    const session = await agent.createSession("ws-fake");
    const events: AgentEvent[] = [];
    await agent.turn(session.id, "hello", {}, (e) => events.push(e));
    expect(events.map((e) => e.kind)).toEqual(["user", "error", "done"]);
    expect(events[1]).toMatchObject({ kind: "error", code: "no_shared_key" });
  });

  test("the step cap is a Setting: the loop stops and says so", async () => {
    const { agent } = loopOverFakes(
      Array.from({ length: 6 }, (_, i) => ({
        toolCalls: [{ id: `loop-${i}`, name: "search_threads", args: {} }],
      })),
      { maxSteps: 2 },
    );
    const session = await agent.createSession("ws-fake");
    const events: AgentEvent[] = [];
    await agent.turn(session.id, "keep searching", {}, (e) => events.push(e));
    expect(events.filter((e) => e.kind === "tool")).toHaveLength(4);
    expect(
      events.some((e) => e.kind === "text" && e.text.startsWith("Stopped after 2 steps")),
    ).toBe(true);
  });
});
