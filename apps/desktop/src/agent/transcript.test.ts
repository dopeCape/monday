// The composer's pure parts: the transcript reduction (streamed text grows
// in place, a card appears once in its latest state), the card's status
// line and buttons per tier and state, the suggestion chips, the runtime
// line, and the SSE reader the Api uses.

import { describe, expect, test } from "bun:test";
import { defaultSettings, type ToolCall } from "@monday/shared";
import { readEvents } from "../platform/api.ts";
import { toolEvent } from "./client.ts";
import { desiredRuntime, runtimeLine, sameRuntime } from "./runtimeLine.ts";
import { suggestionsFor } from "./suggestions.ts";
import { applyEvents, cardActions, statusLabel, toolTitle, waitingCalls } from "./transcript.ts";

const strings = defaultSettings();

const call = (over: Partial<ToolCall>): ToolCall => ({
  id: "c1",
  sessionId: null,
  runId: null,
  tool: "archive_threads",
  tier: "reversible",
  inputSummary: "12 threads",
  status: "done",
  approvedBy: null,
  undoable: false,
  ...over,
});

describe("transcript", () => {
  test("deltas grow one text part until the answer replaces it; a card is replaced in place", () => {
    const events = applyEvents(
      [],
      [
        { kind: "user", id: "u1", text: "hi" },
        { kind: "delta", id: "t1", text: "Look" },
        { kind: "delta", id: "t1", text: "ing" },
        toolEvent({ id: "c1", tool: "search_threads", status: "running" }),
        { kind: "text", id: "t1", text: "Looking." },
        toolEvent({ id: "c1", tool: "search_threads", status: "done", result: "3 threads" }),
        { kind: "done", id: "d1", waiting: null },
      ],
    );
    expect(events.map((e) => e.kind)).toEqual(["user", "text", "tool"]);
    expect(events[1]).toEqual({ kind: "text", id: "t1", text: "Looking." });
    expect(events[2]?.kind === "tool" ? events[2].call.result : null).toBe("3 threads");
    expect(waitingCalls(events)).toEqual([]);
    const waiting = applyEvents(events, [
      toolEvent({ id: "c2", tool: "send_draft", status: "waiting" }),
    ]);
    expect(waitingCalls(waiting).map((c) => c.id)).toEqual(["c2"]);
  });

  test("the card's buttons follow the tier and the state", () => {
    expect(cardActions(call({ status: "waiting", tier: "reversible" }), strings)).toEqual([
      "Apply",
      "Cancel",
    ]);
    expect(cardActions(call({ status: "waiting", tier: "always-ask" }), strings)).toEqual([
      "Approve",
      "Cancel",
    ]);
    expect(cardActions(call({ status: "done", undoable: true }), strings)).toEqual(["Undo"]);
    expect(
      cardActions(
        call({ status: "done", undoable: true, undoneAt: "2026-09-17T10:00:00Z" }),
        strings,
      ),
    ).toEqual([]);
    expect(cardActions(call({ status: "done", tier: "read-only" }), strings)).toEqual([]);
    expect(cardActions(call({ status: "failed" }), strings)).toEqual([]);
  });

  test("the status line: waiting, running, failed, declined, undone, applied, or a read tool's result", () => {
    expect(statusLabel(call({ status: "waiting" }), strings)).toBe("Needs approval");
    expect(statusLabel(call({ status: "running" }), strings)).toBe("Running");
    expect(statusLabel(call({ status: "failed" }), strings)).toBe("Failed");
    expect(statusLabel(call({ declined: true }), strings)).toBe("Cancelled");
    expect(statusLabel(call({ undoneAt: "2026-09-17T10:00:00Z" }), strings)).toBe("Undone");
    expect(statusLabel(call({ approvedBy: "user", undoable: true }), strings)).toBe("Applied");
    expect(
      statusLabel(
        call({ tool: "search_threads", tier: "read-only", result: "12 threads" }),
        strings,
      ),
    ).toBe("12 threads");
    expect(toolTitle(call({ tool: "search_threads", status: "running" }))).toBe("Searching mail");
    expect(toolTitle(call({ tool: "archive_threads" }))).toBe("Archived");
    expect(toolTitle(call({ tool: "make_tea" }))).toBe("make tea");
    // An external caller's card names the caller (slice 19).
    expect(
      toolTitle(call({ tool: "archive_threads", status: "waiting", actorName: "ops bot" })),
    ).toBe("Archive, asked by ops bot");
  });

  test("suggestion chips: pending approvals, then Needs your reply, then the evergreen Setting, capped", () => {
    const thread = { id: "t", section: "needs-reply" } as never;
    const chips = suggestionsFor({
      settings: strings,
      waiting: [call({ status: "waiting", tool: "send_draft" })],
      pausedRuns: [{ workflowName: "Candidate intake", stepName: "Slack" }],
      external: [
        {
          activityId: "a-ext",
          workspaceId: "ws",
          credentialId: "c1",
          credentialName: "ops bot",
          tool: "archive_threads",
          inputSummary: "12 threads",
          status: "waiting",
          text: null,
          sessionId: "s-ext",
          at: "2026-09-19T10:00:00Z",
        },
      ],
      needsReply: [thread, thread, thread],
    });
    expect(chips.map((c) => c.label)).toEqual([
      "Decide on the pending send draft",
      "Decide on the archive threads that ops bot asks for",
      "Decide on the Slack step waiting in Candidate intake",
      "Reply to the 3 threads waiting on me",
    ]);
    // The external chip opens the caller's Session, where the card waits, instead of sending a turn.
    expect(chips[1]?.session).toBe("s-ext");
    const capped = suggestionsFor({
      settings: {
        ...strings,
        "ai.suggestions.max": 2,
        "agent.suggestions.evergreen": ["One", "Two", "Three"],
      },
      waiting: [],
      needsReply: [],
    });
    expect(capped.map((c) => c.label)).toEqual(["One", "Two"]);
    // Every sentence is a Setting: reworded, the chips follow.
    const reworded = suggestionsFor({
      settings: {
        ...strings,
        "strings.agent.chip.pending": "Answer the {tool}",
        "strings.agent.chip.reply_one": "One thread waits",
      },
      waiting: [call({ status: "waiting", tool: "send_draft" })],
      needsReply: [thread],
    });
    expect(reworded.map((c) => c.label).slice(0, 2)).toEqual([
      "Answer the send draft",
      "One thread waits",
    ]);
  });

  test("the header line names the Runtime and the address", () => {
    // ai.mode defaults to local: the header names the CLI until a hosted Session exists.
    expect(runtimeLine(null, strings, "me@example.test")).toBe("Claude Code · me@example.test");
    expect(runtimeLine(null, { ...strings, "ai.mode": "hosted" }, "me@example.test")).toBe(
      "Anthropic · me@example.test",
    );
    expect(
      runtimeLine(
        {
          runtime: { kind: "hosted", provider: "anthropic", model: "claude-sonnet-5" },
          model: "claude-sonnet-5",
        },
        strings,
        "me@example.test",
      ),
    ).toBe("Anthropic claude-sonnet-5 · me@example.test");
    // A Local runtime names its model once the CLI reported it.
    expect(
      runtimeLine(
        { runtime: { kind: "local", cli: "claude-code" }, model: null },
        strings,
        "me@example.test",
      ),
    ).toBe("Claude Code · me@example.test");
    expect(
      runtimeLine(
        { runtime: { kind: "local", cli: "codex" }, model: "gpt-5.6-sol" },
        strings,
        "me@example.test",
      ),
    ).toBe("Codex (gpt-5.6-sol) · me@example.test");
    // A CLI detection ruled out says so in the header (docs/spec/agent-composer.md).
    const missing = {
      cli: "claude-code" as const,
      command: "claude",
      installed: false,
      version: null,
      loggedIn: null,
      reason: "not here",
    };
    expect(runtimeLine(null, strings, "me@example.test", { "claude-code": missing })).toBe(
      "Claude Code not available · me@example.test",
    );
    expect(
      runtimeLine(null, strings, "me@example.test", {
        "claude-code": {
          ...missing,
          installed: true,
          version: "2.1.223",
          loggedIn: true,
          reason: null,
        },
      }),
    ).toBe("Claude Code · me@example.test");
  });

  test("the Runtime the Settings ask for, and what counts as the same one", () => {
    expect(desiredRuntime(strings)).toEqual({ kind: "local", cli: "claude-code" });
    expect(desiredRuntime({ ...strings, "ai.local.model.claude-code": "opus" })).toEqual({
      kind: "local",
      cli: "claude-code",
      model: "opus",
    });
    expect(desiredRuntime({ ...strings, "ai.mode": "hosted" })).toEqual({
      kind: "hosted",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(
      sameRuntime(
        { kind: "local", cli: "claude-code" },
        { kind: "local", cli: "claude-code", model: "claude-opus-5" },
      ),
    ).toBe(true);
    expect(
      sameRuntime({ kind: "local", cli: "claude-code" }, { kind: "local", cli: "codex" }),
    ).toBe(false);
    expect(
      sameRuntime(
        { kind: "hosted", provider: "anthropic", model: "a" },
        { kind: "local", cli: "codex" },
      ),
    ).toBe(false);
  });

  test("the SSE reader yields each frame as it arrives, across chunk boundaries", async () => {
    const frames = [
      'event: user\ndata: {"kind":"user","id":"u","text":"hi"}\n\n',
      'event: delta\ndata: {"kind":"delta","id":"t","te',
      'xt":"Hel"}\n\nevent: done\ndata: {"kind":"done","id":"d","waiting":null}\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(new TextEncoder().encode(f));
        controller.close();
      },
    });
    const seen: string[] = [];
    await readEvents(new Response(body), (e) => seen.push(e.kind));
    expect(seen).toEqual(["user", "delta", "done"]);
  });
});
