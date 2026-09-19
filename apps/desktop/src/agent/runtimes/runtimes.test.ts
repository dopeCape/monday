// The three Local adapters through the AgentSession seam over the fake
// process runner replaying each CLI's recorded stream (fixtures/), and a
// fake line to the Server: the exact command line each CLI is launched with
// (checked against the Tauri capability's own argument validators), the
// built-ins stripped unless Developer mode, the stream mapped to the same
// events the Hosted loop emits, a monday tool that asks pausing the turn
// until the card is answered, the CLI's own tool in Developer mode as a
// marked card, failures, and detection.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentEvent,
  AgentSession,
  ApprovalDecision,
  Runtime,
  SessionStartContext,
  ToolCall,
} from "@monday/shared";
import capability from "../../../src-tauri/capabilities/default.json";
import { claudeArgs, createClaudeCodeSession, mcpConfigFor } from "./claudeCode.ts";
import { codexThreadStartParams, createCodexSession } from "./codex.ts";
import { detectRuntime, detectRuntimes, versionOf } from "./detect.ts";
import type { SessionLink } from "./link.ts";
import { createOpencodeSession, opencodeConfig } from "./opencode.ts";
import {
  type FakeProcessScript,
  type FakeReply,
  fakeProcessRunner,
  type ProcessRunner,
} from "./process.ts";
import type { LocalRuntimeDeps } from "./session.ts";

const here = import.meta.dir;
const fixture = (name: string): string[] =>
  readFileSync(join(here, "fixtures", name), "utf8")
    .split("\n")
    .filter((l) => l.trim());

const MCP = { url: "http://127.0.0.1:4242/mcp/local", token: "device-token" };
const NOW = new Date("2026-09-19T10:00:00Z");

let seq = 0;
const newId = () => `id-${++seq}`;

/** A card as the Server would stream it for a monday tool. */
function card(
  id: string,
  tool: string,
  status: ToolCall["status"],
  extra: Partial<ToolCall> = {},
): AgentEvent {
  return {
    kind: "tool",
    call: {
      id,
      sessionId: "s1",
      runId: null,
      tool,
      tier: "reversible",
      inputSummary: "12 threads",
      status,
      approvedBy: null,
      undoable: false,
      ...extra,
    },
    preview: status === "waiting" ? { kind: "text", text: "12 threads" } : null,
  };
}

/** The line to the Server, faked: cards are pushed by the test, approvals are recorded and answered. */
function fakeLink() {
  const listeners = new Map<string, Set<(e: AgentEvent) => void>>();
  const appended: AgentEvent[] = [];
  const approvals: Array<{ activityId: string; decision: ApprovalDecision }> = [];
  const switches: Runtime[] = [];
  let onApprove: ((activityId: string, decision: ApprovalDecision) => void) | null = null;
  const emit = (sessionId: string, event: AgentEvent) => {
    for (const l of listeners.get(sessionId) ?? []) l(event);
  };
  const link: SessionLink = {
    live(sessionId, listener) {
      const set = listeners.get(sessionId) ?? new Set();
      set.add(listener);
      listeners.set(sessionId, set);
      return () => set.delete(listener);
    },
    async append(_sessionId, event) {
      appended.push(event);
    },
    async approve(_sessionId, activityId, decision) {
      approvals.push({ activityId, decision });
      onApprove?.(activityId, decision);
    },
    async switchRuntime(_sessionId, runtime) {
      switches.push(runtime);
      return { kind: "runtime", id: newId(), runtime };
    },
  };
  return {
    link,
    appended,
    approvals,
    switches,
    emit,
    /** Resolves when the adapter answers a card. */
    approval: () =>
      new Promise<{ activityId: string; decision: ApprovalDecision }>((resolve) => {
        onApprove = (activityId, decision) => {
          onApprove = null;
          resolve({ activityId, decision });
        };
      }),
  };
}

function context(over: Partial<SessionStartContext> = {}): SessionStartContext {
  return {
    workspaceId: "ws-fake",
    sessionId: "s1",
    address: "me@example.test",
    epoch: 0,
    transcript: [],
    developerMode: false,
    webFetch: false,
    pinned: ["appearance.mode"],
    ...over,
  };
}

function depsOver(runner: ProcessRunner, link: SessionLink): LocalRuntimeDeps {
  return {
    runner,
    link,
    mcp: MCP,
    settings: () => ({
      command: "claude",
      model: "",
      toolTimeoutSeconds: 3600,
      systemPrompt: "You are monday.",
    }),
    now: () => NOW,
    newId,
    log: () => {},
  };
}

/** Collects a turn's events and resolves with the outcome. */
async function turn(
  _session: AgentSession,
  run: (onEvent: (e: AgentEvent) => void) => Promise<{ waiting: string | null }>,
) {
  const events: AgentEvent[] = [];
  const outcome = await run((e) => events.push(e));
  return { events, outcome };
}

const kinds = (events: AgentEvent[]) =>
  events.map((e) => (e.kind === "tool" ? `tool:${e.call.tool}:${e.call.status}` : e.kind));

/* ------------------------------ Replays ------------------------------ */

interface ClaudeHooks {
  /** What the Server answers a monday tool with; the recorded text by default. */
  toolResult?: (name: string, input: unknown, recorded: string) => Promise<string>;
}

/**
 * Replays the recorded Claude Code stream for one turn: the init line at
 * spawn, then every line after the first stdin line. A tool_result line
 * waits for the hook, as the real CLI waits for the MCP call.
 */
function claudeScript(lines: string[], hooks: ClaudeHooks = {}): FakeProcessScript {
  const [init, ...rest] = lines;
  const pendingCalls = new Map<string, { name: string; input: unknown }>();
  const reply: FakeReply = async function* () {
    for (const line of rest) {
      const parsed = JSON.parse(line) as {
        type: string;
        message?: { content?: Array<Record<string, unknown>> };
      };
      if (parsed.type === "assistant") {
        for (const block of parsed.message?.content ?? []) {
          if (block.type === "tool_use") {
            pendingCalls.set(String(block.id), {
              name: String(block.name),
              input: block.input,
            });
          }
        }
      }
      if (parsed.type === "user" && hooks.toolResult) {
        const content = parsed.message?.content ?? [];
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const call = pendingCalls.get(String(block.tool_use_id));
          const recorded = (block.content as Array<{ text: string }>)[0]?.text ?? "";
          const text = await hooks.toolResult(call?.name ?? "", call?.input, recorded);
          block.content = [{ type: "text", text }];
        }
        yield JSON.stringify(parsed);
        continue;
      }
      yield line;
    }
  };
  return { greeting: init ? [init] : [], replies: [reply], exitCode: 0 };
}

describe("the Claude Code adapter", () => {
  const scope = capability.permissions.find(
    (p): p is Extract<typeof p, { identifier: string }> =>
      typeof p === "object" && "identifier" in p && p.identifier === "shell:allow-execute",
  );
  const allowed = (scope?.allow ?? []) as Array<{ name?: string; args?: unknown }>;
  const claudeScope = allowed.find((a) => a.name === "claude") as
    | { args: Array<string | { validator: string }> }
    | undefined;

  /** The Tauri shell scope's rule: fixed entries must match, validators are anchored regexes. */
  function allowedByScope(args: string[]): string | null {
    if (!claudeScope) return "no claude scope";
    if (args.length !== claudeScope.args.length) {
      return `expected ${claudeScope.args.length} args, got ${args.length}`;
    }
    for (const [i, rule] of claudeScope.args.entries()) {
      const value = args[i] ?? "";
      if (typeof rule === "string") {
        if (rule !== value) return `arg ${i}: "${value}" is not "${rule}"`;
      } else if (!new RegExp(`^${rule.validator}$`).test(value)) {
        return `arg ${i}: "${value}" fails ${rule.validator}`;
      }
    }
    return null;
  }

  test("is launched in print mode with stream-json, monday's MCP server and every built-in off, in the capability's shape", () => {
    const args = claudeArgs(
      context(),
      MCP,
      "You are monday.",
      "6f1c2a4e-3b7d-4e9a-9c1f-2d8e5a7b4c01",
    );
    expect(args).toEqual([
      "-p",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfigFor(MCP, context()),
      "--setting-sources",
      "",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "mcp__monday",
      "--tools",
      "",
      "--system-prompt",
      "You are monday.",
      "--session-id",
      "6f1c2a4e-3b7d-4e9a-9c1f-2d8e5a7b4c01",
      "--no-session-persistence",
    ]);
    expect(JSON.parse(mcpConfigFor(MCP, context()))).toEqual({
      mcpServers: {
        monday: {
          type: "http",
          url: MCP.url,
          headers: {
            Authorization: "Bearer device-token",
            "X-Monday-Workspace": "ws-fake",
            "X-Monday-Session": "s1",
            "X-Monday-Pinned": "appearance.mode",
          },
        },
      },
    });
    expect(allowedByScope(args)).toBeNull();
    // Developer mode: the built-ins come back, edits auto-accepted, the web tools only with web fetch.
    const dev = claudeArgs(
      context({ developerMode: true }),
      MCP,
      "Line one\nLine two",
      "6f1c2a4e-3b7d-4e9a-9c1f-2d8e5a7b4c01",
    );
    expect(dev[13]).toBe("acceptEdits");
    expect(dev[15]).toBe("mcp__monday,Bash,Read,Edit,Write,MultiEdit,Glob,Grep,Agent");
    expect(dev[17]).toBe("default");
    expect(allowedByScope(dev)).toBeNull();
    const web = claudeArgs(
      context({ developerMode: true, webFetch: true }),
      MCP,
      "x",
      "6f1c2a4e-3b7d-4e9a-9c1f-2d8e5a7b4c01",
    );
    expect(web[15]).toContain("WebFetch");
    expect(allowedByScope(web)).toBeNull();
    // Anything else is refused by the scope.
    expect(
      allowedByScope([...args.slice(0, 13), "bypassPermissions", ...args.slice(14)]),
    ).toContain("fails");
  });

  test("archive every newsletter older than a week: the recorded stream becomes the Hosted loop's events, pausing at the card the Server raises", async () => {
    const link = fakeLink();
    const lines = fixture("claude-code.stream.jsonl");
    const runner = fakeProcessRunner({
      claude: claudeScript(lines, {
        toolResult: async (name, _input, recorded) => {
          if (name === "mcp__monday__search_threads") {
            link.emit(
              "s1",
              card("a1", "search_threads", "done", { tier: "read-only", result: "12 threads" }),
            );
            return recorded;
          }
          // The Server's card asks; the CLI's MCP call waits until the composer answers.
          link.emit("s1", card("a2", "archive_threads", "waiting"));
          const { decision } = await link.approval();
          link.emit(
            "s1",
            card("a2", "archive_threads", "done", {
              approvedBy: decision === "approved" ? "user" : null,
              undoable: decision === "approved",
              result: "Archive: 12 threads.",
            }),
          );
          return "Archive: 12 threads.";
        },
      }),
    });
    const session = createClaudeCodeSession(depsOver(runner.runner, link.link));
    await session.start(context());
    expect(runner.spawns).toHaveLength(1);
    expect(runner.spawns[0]?.command).toBe("claude");
    expect(runner.spawns[0]?.options.env).toEqual({
      MCP_TOOL_TIMEOUT: "3600000",
      MCP_TIMEOUT: "30000",
    });
    expect(session.runtime()).toEqual({
      runtime: { kind: "local", cli: "claude-code", model: "claude-sonnet-5" },
      model: "claude-sonnet-5",
    });

    const first = await turn(session, (on) =>
      session.send("archive every newsletter older than a week", on),
    );
    expect(first.outcome.waiting).toBe("a2");
    expect(kinds(first.events)).toEqual([
      "user",
      "tool:search_threads:done",
      "delta",
      "delta",
      "delta",
      "delta",
      "delta",
      "text",
      "tool:archive_threads:waiting",
      "done",
    ]);
    const streamed = first.events
      .filter((e) => e.kind === "delta")
      .map((e) => e.text)
      .join("");
    expect(streamed).toBe("Found 12 newsletters older than a week. Archiving them now.");
    const text = first.events.find((e) => e.kind === "text");
    expect(text).toEqual({
      kind: "text",
      id: "msg_011CfCekTy9SPTVSMHRitj3L:0",
      text: "Found 12 newsletters older than a week. Archiving them now.",
    });
    // The deltas and the text share an id, so the composer grows the text in place.
    expect(first.events.filter((e) => e.kind === "delta").every((e) => e.id === text?.id)).toBe(
      true,
    );
    // The CLI got exactly one user line, in stream-json.
    expect(runner.spawns[0]?.process.written).toEqual([
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "archive every newsletter older than a week" }],
        },
      }),
    ]);

    // Approve: the card moves on, the CLI's call returns, the turn runs to its result.
    const second = await turn(session, (on) => session.resume("a2", "approved", on));
    expect(link.approvals).toEqual([{ activityId: "a2", decision: "approved" }]);
    expect(second.outcome.waiting).toBeNull();
    expect(kinds(second.events)).toEqual([
      "tool:archive_threads:done",
      "delta",
      "delta",
      "delta",
      "delta",
      "delta",
      "delta",
      "text",
      "done",
    ]);
    expect(second.events.find((e) => e.kind === "text")?.text).toBe(
      "Archived all 12 newsletters older than a week (up to 2026-09-12).",
    );
    // What the CLI said is persisted; deltas and the Server's cards are not.
    expect(link.appended.map((e) => e.kind)).toEqual(["user", "text", "text"]);
    await session.cancel();
    expect(runner.spawns[0]?.process.killed).toBe(true);
  });

  test("a Developer mode built-in shows as a marked card; a runtime switch hands the transcript over", async () => {
    const link = fakeLink();
    const lines = fixture("claude-code.stream.jsonl");
    const init = lines[0] ?? "";
    // A turn in which the CLI ran Bash (Developer mode) and answered.
    const bashTurn = [
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_dev",
          content: [
            { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "ls ~" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_bash", content: "Desktop\nDownloads" },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: { id: "msg_dev2", content: [{ type: "text", text: "Two folders." }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Two folders.",
      }),
    ];
    const runner = fakeProcessRunner({
      claude: { greeting: [init], replies: [() => bashTurn], exitCode: 0 },
    });
    const session = createClaudeCodeSession(depsOver(runner.runner, link.link));
    const transcript: AgentEvent[] = [
      { kind: "user", id: "u0", text: "archive old newsletters" },
      card("a9", "archive_threads", "done", { result: "Archive: 12 threads." }),
      { kind: "text", id: "t0", text: "Archived 12 newsletters." },
      { kind: "runtime", id: "r0", runtime: { kind: "local", cli: "claude-code" } },
    ];
    await session.start(context({ developerMode: true, epoch: 1, transcript }));
    const dev = runner.spawns[0]?.options.args ?? [];
    expect(dev).toContain("acceptEdits");
    expect(dev).toContain("default");

    const result = await turn(session, (on) => session.send("what is in my home folder?", on));
    expect(result.outcome.waiting).toBeNull();
    expect(kinds(result.events)).toEqual([
      "user",
      "tool:Bash:running",
      "tool:Bash:done",
      "text",
      "done",
    ]);
    const bash = result.events.find((e) => e.kind === "tool" && e.call.status === "done");
    expect(bash && bash.kind === "tool" ? bash.call : null).toMatchObject({
      builtin: true,
      tool: "Bash",
      tier: "always-ask",
      inputSummary: "command: ls ~",
      result: "Desktop",
    });
    // The first turn of a new epoch carried the transcript as context, tool calls included.
    const written = runner.spawns[0]?.process.written[0] ?? "";
    const prompt = (JSON.parse(written) as { message: { content: Array<{ text: string }> } })
      .message.content[0]?.text;
    expect(prompt?.startsWith("The conversation so far, from another runtime.")).toBe(true);
    expect(prompt).toContain("Tool archive_threads (12 threads): Archive: 12 threads.");
    expect(prompt?.endsWith("The user continues:\nwhat is in my home folder?")).toBe(true);

    // Turning Developer mode off restarts the CLI without its tools.
    await session.start(context({ developerMode: false, epoch: 1, transcript }));
    expect(runner.spawns).toHaveLength(2);
    expect(runner.spawns[0]?.process.killed).toBe(true);
    expect(runner.spawns[1]?.options.args).toContain("dontAsk");
  });

  test("a CLI that cannot reach monday's tools, or that exits mid-turn, fails the turn with an error card", async () => {
    const link = fakeLink();
    const init = JSON.parse(fixture("claude-code.stream.jsonl")[0] ?? "{}") as {
      mcp_servers: Array<{ name: string; status: string }>;
    };
    init.mcp_servers = [{ name: "monday", status: "failed" }];
    const runner = fakeProcessRunner({
      claude: { greeting: [JSON.stringify(init)], replies: [() => []], exitCode: 1 },
    });
    const session = createClaudeCodeSession(depsOver(runner.runner, link.link));
    await session.start(context());
    // The init line said monday's server did not connect: the first turn fails with that reason,
    // and the exit that follows adds nothing.
    const pending = turn(session, (on) => session.send("hello", on));
    runner.spawns[0]?.process.exit(1);
    const result = await pending;
    expect(kinds(result.events)).toEqual(["user", "error", "done"]);
    const error = result.events.find((e) => e.kind === "error");
    expect(error && error.kind === "error" ? error : null).toMatchObject({
      code: "mcp_unreachable",
      message: "Claude Code could not reach monday's tools (failed).",
    });

    // A CLI that dies mid-turn fails the turn by its exit.
    const dying = fakeProcessRunner({
      claude: { greeting: [fixture("claude-code.stream.jsonl")[0] ?? ""], replies: [() => []] },
    });
    const short = createClaudeCodeSession(depsOver(dying.runner, link.link));
    await short.start(context());
    const pendingExit = turn(short, (on) => short.send("hello", on));
    await new Promise((r) => setTimeout(r, 0));
    dying.spawns[0]?.process.exit(137);
    const exited = await pendingExit;
    expect(kinds(exited.events)).toEqual(["user", "error", "done"]);
    const exitError = exited.events.find((e) => e.kind === "error");
    expect(exitError && exitError.kind === "error" ? exitError.message : "").toContain(
      "exited (code 137)",
    );

    // Not installed: the spawn itself fails and start throws with the reason.
    const missing = fakeProcessRunner({});
    const none = createClaudeCodeSession(depsOver(missing.runner, link.link));
    await expect(none.start(context())).rejects.toThrow(/command not found/);
  });
});

/* ------------------------------ Codex ------------------------------ */

/** Replays the recorded app-server exchange: each stdin line gets the lines recorded after it. */
function codexScript(lines: string[], onArchive?: () => Promise<void>): FakeProcessScript {
  const at = (pred: (o: Record<string, unknown>) => boolean) =>
    lines.findIndex((l) => pred(JSON.parse(l) as Record<string, unknown>));
  const result1 = at((o) => o.id === 1);
  const result2 = at((o) => o.id === 2);
  const result3 = at((o) => o.id === 3);
  const elicit = at((o) => o.method === "mcpServer/elicitation/request");
  const afterInit = lines.slice(result1, result2);
  const afterThread = lines.slice(result2, result3);
  const untilElicit = lines.slice(result3, elicit + 1);
  const afterElicit = lines.slice(elicit + 1);
  // Codex asks before it calls; the MCP call itself (which blocks on the card) comes after the answer.
  const archiveCompleted = (l: string) =>
    l.includes('"item/completed"') && l.includes('"tool":"archive_threads"');
  return {
    replies: [
      () => afterInit, // initialize
      () => [], // initialized
      () => afterThread, // thread/start
      () => untilElicit, // turn/start, up to and including the elicitation request
      async function* () {
        for (const l of afterElicit) {
          if (archiveCompleted(l) && onArchive) await onArchive();
          yield l;
        }
      }, // the elicitation answer: the tool runs, then the turn finishes
    ],
    exitCode: 0,
  };
}

describe("the Codex adapter", () => {
  test("starts a thread with monday's server in its config and the built-ins off, and answers the MCP elicitation itself", async () => {
    const params = codexThreadStartParams(MCP, context(), "You are monday.", "");
    expect(params).toMatchObject({
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      baseInstructions: "You are monday.",
      config: {
        mcp_servers: {
          monday: {
            url: MCP.url,
            http_headers: { Authorization: "Bearer device-token", "X-Monday-Session": "s1" },
            default_tools_approval_mode: "auto",
          },
        },
        features: { shell_tool: false, unified_exec: false, apps: false, browser_use: false },
        web_search: "disabled",
        tools: { view_image: false },
      },
    });
    expect(params.model).toBeUndefined();
    const dev = codexThreadStartParams(
      MCP,
      context({ developerMode: true, webFetch: true }),
      "x",
      "gpt-5",
    );
    expect(dev).toMatchObject({
      sandbox: "danger-full-access",
      model: "gpt-5",
      config: { features: { shell_tool: true, unified_exec: true }, web_search: "live" },
    });

    const link = fakeLink();
    const lines = fixture("codex.app-server.jsonl");
    const runner = fakeProcessRunner({
      codex: codexScript(lines, async () => {
        link.emit("s1", card("a2", "archive_threads", "waiting"));
        await link.approval();
        link.emit(
          "s1",
          card("a2", "archive_threads", "done", {
            approvedBy: "user",
            undoable: true,
            result: "Archive: 12 threads.",
          }),
        );
      }),
    });
    const session = createCodexSession({
      ...depsOver(runner.runner, link.link),
      settings: () => ({
        command: "codex",
        model: "",
        toolTimeoutSeconds: 3600,
        systemPrompt: "You are monday.",
      }),
    });
    await session.start(context());
    expect(runner.spawns[0]?.options.args).toEqual(["app-server"]);
    expect(session.runtime()).toEqual({
      runtime: { kind: "local", cli: "codex", model: "gpt-5.6-sol" },
      model: "gpt-5.6-sol",
    });
    const written =
      runner.spawns[0]?.process.written.map((l) => JSON.parse(l) as Record<string, unknown>) ?? [];
    expect(written.map((m) => m.method)).toEqual(["initialize", "initialized", "thread/start"]);
    expect(written[0]).toEqual({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "monday", version: "0.1.0" } },
    });
    expect(written[2]?.params).toMatchObject({ config: { features: { shell_tool: false } } });

    const first = await turn(session, (on) =>
      session.send("archive every newsletter older than a week", on),
    );
    expect(first.outcome.waiting).toBe("a2");
    expect(kinds(first.events)).toEqual(["user", "tool:archive_threads:waiting", "done"]);
    // The elicitation was accepted by the adapter, since the approval lives inside the tool.
    const answers =
      runner.spawns[0]?.process.written.map((l) => JSON.parse(l) as Record<string, unknown>) ?? [];
    expect(answers.map((m) => m.method ?? "answer")).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
      "answer",
    ]);
    expect(answers.at(-1)).toEqual({ id: 0, result: { action: "accept", content: {} } });

    const second = await turn(session, (on) => session.resume("a2", "approved", on));
    expect(second.outcome.waiting).toBeNull();
    const deltas = second.events
      .filter((e) => e.kind === "delta")
      .map((e) => e.text)
      .join("");
    expect(deltas).toBe("Archived 12 newsletters older than one week.");
    expect(second.events.find((e) => e.kind === "text")).toEqual({
      kind: "text",
      id: "msg_0ee3d8c3d26ebcf8016aae667ff3ac87d0b373b51f6c55e5df",
      text: "Archived 12 newsletters older than one week.",
    });
    expect(kinds(second.events).at(-1)).toBe("done");
    expect(link.appended.map((e) => e.kind)).toEqual(["user", "text"]);

    await session.cancel();
    const last = runner.spawns[0]?.process.written.at(-1) ?? "";
    expect(JSON.parse(last)).toMatchObject({ method: "turn/interrupt" });
  });
});

/* ------------------------------ OpenCode ------------------------------ */

function opencodeScript(lines: string[], onArchive?: () => Promise<void>): FakeProcessScript {
  const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const at = (pred: (o: Record<string, unknown>) => boolean) => parsed.findIndex(pred);
  const r1 = at((o) => o.id === 1 && !o.method);
  const r2 = at((o) => o.id === 2 && !o.method);
  const permission = at((o) => o.method === "session/request_permission");
  const untilPermission = lines.slice(r2 + 1, permission + 1);
  const afterPermission = lines.slice(permission + 1);
  // The agent asks before it calls; the MCP call (which blocks on the card) comes after the answer.
  const archiveCompleted = (l: string) =>
    l.includes('"tool_call_update"') && l.includes('"call_02"') && l.includes('"completed"');
  return {
    replies: [
      () => [lines[r1] ?? ""], // initialize
      () => [lines[r2] ?? ""], // session/new
      () => untilPermission, // session/prompt, up to and including the permission request
      async function* () {
        for (const l of afterPermission) {
          if (archiveCompleted(l) && onArchive) await onArchive();
          yield l;
        }
      }, // the permission answer: the tool runs, then the prompt finishes
    ],
    exitCode: 0,
  };
}

describe("the OpenCode adapter", () => {
  test("denies every tool but monday's in its config, allows monday's permission requests, and maps ACP updates to events", async () => {
    const config = opencodeConfig(MCP, context(), "");
    expect(config).toMatchObject({
      mcp: {
        monday: { type: "remote", url: MCP.url, headers: { Authorization: "Bearer device-token" } },
      },
      permission: { "*": "deny", "monday_*": "allow" },
    });
    expect(
      opencodeConfig(MCP, context({ developerMode: true }), "anthropic/claude-sonnet-5"),
    ).toMatchObject({
      model: "anthropic/claude-sonnet-5",
      permission: { "*": "allow", webfetch: "deny", websearch: "deny" },
    });

    const link = fakeLink();
    const runner = fakeProcessRunner({
      opencode: opencodeScript(fixture("opencode.acp.jsonl"), async () => {
        link.emit("s1", card("a2", "archive_threads", "waiting"));
        await link.approval();
        link.emit(
          "s1",
          card("a2", "archive_threads", "done", {
            approvedBy: "user",
            undoable: true,
            result: "Archive: 12 threads.",
          }),
        );
      }),
    });
    const session = createOpencodeSession({
      ...depsOver(runner.runner, link.link),
      settings: () => ({
        command: "opencode",
        model: "",
        toolTimeoutSeconds: 3600,
        systemPrompt: "You are monday.",
      }),
    });
    await session.start(context());
    expect(runner.spawns[0]?.options.args).toEqual(["acp"]);
    const env = runner.spawns[0]?.options.env ?? {};
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}")).toMatchObject({
      permission: { "*": "deny" },
    });
    const written = () =>
      runner.spawns[0]?.process.written.map((l) => JSON.parse(l) as Record<string, unknown>) ?? [];
    expect(written().map((m) => m.method)).toEqual(["initialize", "session/new"]);
    expect(written()[1]?.params).toMatchObject({
      mcpServers: [{ type: "http", name: "monday", url: MCP.url }],
    });
    expect(session.runtime().model).toBe("anthropic/claude-sonnet-5");

    const first = await turn(session, (on) =>
      session.send("archive every newsletter older than a week", on),
    );
    expect(first.outcome.waiting).toBe("a2");
    expect(kinds(first.events)).toEqual([
      "user",
      "delta",
      "delta",
      "text",
      "tool:archive_threads:waiting",
      "done",
    ]);
    expect(first.events.find((e) => e.kind === "text")?.text).toBe("Looking for old newsletters.");
    // monday's own tool: the permission request is allowed at once.
    expect(written().at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 0,
      result: { outcome: { outcome: "selected", optionId: "once" } },
    });

    const second = await turn(session, (on) => session.resume("a2", "approved", on));
    expect(second.outcome.waiting).toBeNull();
    expect(kinds(second.events)).toEqual(["tool:archive_threads:done", "delta", "text", "done"]);
    expect(second.events.find((e) => e.kind === "text")?.text).toBe(
      "Archived 12 newsletters older than a week.",
    );
    expect(link.appended.map((e) => e.kind)).toEqual(["user", "text", "text"]);
  });

  test("a permission request for a built-in is rejected unless the Session is in Developer mode", async () => {
    const link = fakeLink();
    const ask = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: {
        sessionId: "ses",
        toolCall: {
          toolCallId: "c",
          title: "bash",
          kind: "execute",
          rawInput: { command: "rm -rf /" },
        },
        options: [
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    const lines = fixture("opencode.acp.jsonl");
    for (const developerMode of [false, true]) {
      const runner = fakeProcessRunner({
        opencode: {
          replies: [() => [lines[0] ?? ""], () => [lines[1] ?? ""], () => [ask]],
          exitCode: 0,
        },
      });
      const session = createOpencodeSession({
        ...depsOver(runner.runner, link.link),
        settings: () => ({
          command: "opencode",
          model: "",
          toolTimeoutSeconds: 1,
          systemPrompt: "x",
        }),
      });
      await session.start(context({ developerMode }));
      const pending = turn(session, (on) => session.send("wipe it", on));
      await new Promise((r) => setTimeout(r, 5));
      const answer = runner.spawns[0]?.process.written.at(-1) ?? "";
      expect(JSON.parse(answer)).toMatchObject({
        id: 7,
        result: { outcome: { outcome: "selected", optionId: developerMode ? "once" : "reject" } },
      });
      await session.cancel();
      await pending;
    }
  });
});

/* ------------------------------ Detection ------------------------------ */

describe("detection", () => {
  test("reads the version and the login state where the CLI exposes it, and says why a runtime cannot start", async () => {
    const strings = {
      notInstalled: "{runtime} is not installed on this computer.",
      notLoggedIn: "{runtime} is installed but not logged in.",
    };
    const runner = fakeProcessRunner({
      "claude-version": { greeting: ["2.1.223 (Claude Code)"], exitCode: 0 },
      "claude-auth": {
        greeting: ['{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'],
        exitCode: 0,
      },
      "codex-version": { greeting: ["codex-cli 0.146.0"], exitCode: 0 },
      "codex-login": { greeting: ["Not logged in"], exitCode: 1 },
    });
    // The fake processes end as soon as they printed.
    const ending: ProcessRunner = async (command, options) => {
      const p = await runner.runner(command, options);
      const spawned = runner.spawns.at(-1)?.process;
      setTimeout(() => spawned?.exit(command === "codex-login" ? 1 : 0), 0);
      return p;
    };
    const statuses = await detectRuntimes({
      runner: ending,
      commands: { "claude-code": "claude", codex: "/opt/codex/bin/codex", opencode: "opencode" },
      strings,
      timeoutMs: 500,
    });
    expect(statuses["claude-code"]).toEqual({
      cli: "claude-code",
      command: "claude",
      installed: true,
      version: "2.1.223",
      loggedIn: true,
      reason: null,
    });
    expect(statuses.codex).toEqual({
      cli: "codex",
      command: "/opt/codex/bin/codex",
      installed: true,
      version: "0.146.0",
      loggedIn: false,
      reason: "Codex is installed but not logged in.",
    });
    // A path override is searched first, by the scope name, never as a free command.
    expect(runner.spawns.find((s) => s.command === "codex-version")?.options.pathPrefix).toBe(
      "/opt/codex/bin",
    );
    expect(statuses.opencode).toEqual({
      cli: "opencode",
      command: "opencode",
      installed: false,
      version: null,
      loggedIn: null,
      reason: "OpenCode is not installed on this computer.",
    });
    expect(versionOf("opencode 1.18.31")).toBe("1.18.31");
    expect(versionOf("nothing here")).toBeNull();
    const one = await detectRuntime("opencode", {
      runner: ending,
      commands: { "claude-code": "claude", codex: "codex", opencode: "opencode" },
      strings,
    });
    expect(one.installed).toBe(false);
  });
});
