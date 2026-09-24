/// <reference types="bun-types" />
// Slice 15's "done when": the same instruction as slice 14 runs through
// Claude Code and the Activity log shows identical entries. The Hosted loop
// runs first over the fakes with the model scripted to the very tool calls
// Claude Code made when the stream in fixtures/ was recorded. Then the
// Claude Code adapter drives a fake `claude` process that replays that
// recorded stream and, for every tool_use, calls monday's MCP server over
// the real stdio transport in-process, exactly as the CLI would: the batch
// previews above 10, the composer's Apply resumes it, Undo restores every
// Thread, and the Activity rows are equal to the Hosted runtime's for the
// same fixture, ids and timestamps aside.
//
// An opt-in live test at the end spawns the user's installed `claude`
// against the loopback HTTP endpoint; it runs only with MONDAY_LIVE_CLI=1
// and a `claude` on PATH, because it spends the user's own plan.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ActivityRecord, AgentEvent, ApprovalDecision, ToolCall } from "@monday/shared";
// The MCP SDK lives in the server package; the test wants its real stdio transport.
import { Client } from "../../../../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioServerTransport } from "../../../../server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js";
import {
  ReadBuffer,
  serializeMessage,
} from "../../../../server/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js";
import type { Transport } from "../../../../server/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/transport.js";
import type { JSONRPCMessage } from "../../../../server/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js";
import {
  type AgentHost,
  createAgentHost,
  createMemoryActivityLog,
  createMemorySessionStore,
  createMondayMcpServer,
} from "../../../../server/src/intelligence/agent/index.ts";
import {
  createFakeToolHost,
  type FakeThreadInput,
} from "../../../../server/src/intelligence/agent/tools/fake-host.ts";
import {
  createFakeRuntime,
  type FakeStep,
} from "../../../../server/src/intelligence/runtime/fake/index.ts";
import type { AgentMessage } from "../../../../server/src/intelligence/runtime/index.ts";
import { agentRoutes } from "../../../../server/src/routes/agent.ts";
import { createClaudeCodeSession, MONDAY_TOOL_PREFIX } from "./claudeCode.ts";
import type { SessionLink } from "./link.ts";
import {
  type FakeProcessScript,
  type FakeReply,
  fakeProcessRunner,
  type Process,
  type ProcessRunner,
} from "./process.ts";

const NOW = new Date("2026-09-17T10:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const INSTRUCTION = "archive every newsletter older than a week";

/** Twelve newsletters older than a week, two fresh ones, and some other mail: slice 14's fixture. */
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
  ];
  return [...old, ...fresh, ...other];
}

const settings = {
  systemPrompt: "You are monday.",
  maxSteps: 24,
  previewAbove: 10,
  alwaysAsk: [] as string[],
  searchLimit: 100,
};

function hostOverFakes(steps: FakeStep[] = []) {
  const { runtime } = createFakeRuntime({ steps, now: () => NOW.getTime() });
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
    settings: async () => settings,
  });
  return { agent, host, activity, sessions };
}

/**
 * An Activity row without what differs between two runs: its id, the call
 * id, the Session, the time, and the id an undo row points at.
 */
function comparable(row: ActivityRecord) {
  const { id: _id, callId: _c, sessionId: _s, at: _at, ...rest } = row;
  const input =
    rest.input && typeof rest.input.activity_id === "string"
      ? { ...rest.input, activity_id: "<id>" }
      : rest.input;
  return { ...rest, input };
}

const cards = (events: readonly AgentEvent[]) =>
  events.flatMap((e) => (e.kind === "tool" ? [[e.call.tool, e.call.status]] : []));

/** The Device's line to the Server, in-process: the same host the MCP server calls into. */
function hostSessionLink(agent: AgentHost): SessionLink {
  return {
    live: (sessionId, listener) => agent.live(sessionId, listener),
    append: (sessionId, event) => agent.appendEvent(sessionId, event),
    approve: async (sessionId, activityId, decision, context, onEvent) => {
      await agent.resume(sessionId, activityId, decision, context, onEvent);
    },
    switchRuntime: (sessionId, runtime) => agent.switchRuntime(sessionId, runtime),
  };
}

/* ------------------------------ The real stdio transport, in-process ------------------------------ */

/** The CLI's end of the pipes: newline-delimited JSON-RPC, as the SDK's stdio client reads it. */
function pipeClientTransport(input: PassThrough, output: PassThrough): Transport {
  const buffer = new ReadBuffer();
  const transport: Transport = {
    async start() {
      input.on("data", (chunk: Buffer) => {
        buffer.append(chunk);
        for (;;) {
          let message: JSONRPCMessage | null;
          try {
            message = buffer.readMessage();
          } catch (error) {
            transport.onerror?.(error as Error);
            return;
          }
          if (!message) return;
          transport.onmessage?.(message);
        }
      });
    },
    async send(message) {
      output.write(serializeMessage(message));
    },
    async close() {
      transport.onclose?.();
    },
  };
  return transport;
}

/** monday's MCP server on a stdio transport over in-memory pipes, and the CLI-side client on the other ends. */
async function mcpOverStdio(agent: AgentHost, workspaceId: string, sessionId: string) {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = await createMondayMcpServer(agent, { workspaceId, sessionId });
  await server.connect(new StdioServerTransport(toServer, toClient));
  const client = new Client({ name: "claude-code", version: "2.1.223" });
  await client.connect(pipeClientTransport(toClient, toServer));
  return { client, server };
}

/* ------------------------------ The fake Claude Code process ------------------------------ */

const fixtureLines = (): string[] =>
  readFileSync(join(import.meta.dir, "fixtures", "claude-code.stream.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim());

/**
 * Replays the recorded stream and, at each tool_use, makes the real MCP
 * call the CLI made, putting its real result in the tool_result line.
 */
function claudeCodeOverMcp(lines: string[], client: Client): FakeProcessScript {
  const [init, ...rest] = lines;
  const calls = new Map<string, { name: string; input: unknown }>();
  const reply: FakeReply = async function* () {
    for (const line of rest) {
      const parsed = JSON.parse(line) as {
        type: string;
        message?: { content?: Array<Record<string, unknown>> };
      };
      if (parsed.type === "assistant") {
        for (const block of parsed.message?.content ?? []) {
          if (block.type === "tool_use") {
            calls.set(String(block.id), { name: String(block.name), input: block.input });
          }
        }
        yield line;
        continue;
      }
      if (parsed.type === "user") {
        for (const block of parsed.message?.content ?? []) {
          if (block.type !== "tool_result") continue;
          const call = calls.get(String(block.tool_use_id));
          if (!call) continue;
          const result = await client.callTool({
            name: call.name.slice(MONDAY_TOOL_PREFIX.length),
            arguments: (call.input ?? {}) as Record<string, unknown>,
          });
          block.content = result.content;
          if (result.isError) block.is_error = true;
        }
        yield JSON.stringify(parsed);
        continue;
      }
      yield line;
    }
  };
  return { greeting: init ? [init] : [], replies: [reply], exitCode: 0 };
}

/** The ids the search tool answered with, from the transcript the Hosted model sees. */
const idsFromSearch = (messages: AgentMessage[]): string[] => {
  const tool = [...messages]
    .reverse()
    .find((m) => m.role === "tool" && m.name === "search_threads");
  if (tool?.role !== "tool") return [];
  const json = tool.content.slice(tool.content.indexOf("["));
  return (JSON.parse(json) as Array<{ id: string }>).map((t) => t.id);
};

describe("the same instruction as slice 14 through Claude Code", () => {
  test("archive every newsletter older than a week works through Claude Code and the Activity log shows identical entries", async () => {
    // The Hosted runtime first, scripted to the calls Claude Code made in the recording.
    const hosted = hostOverFakes([
      {
        toolCalls: [
          {
            id: "toolu_h1",
            name: "search_threads",
            args: { query: "newsletter", older_than_days: 7 },
          },
        ],
      },
      (call) => ({
        text: "Found 12 newsletters older than a week. Archiving them now.",
        toolCalls: [
          {
            id: "toolu_h2",
            name: "archive_threads",
            args: { thread_ids: idsFromSearch(call.messages) },
          },
        ],
      }),
      "Archived all 12 newsletters older than a week (up to 2026-09-12).",
    ]);
    const hostedSession = await hosted.agent.createSession("ws-fake");
    const hostedEvents: AgentEvent[] = [];
    const paused = await hosted.agent.turn(hostedSession.id, INSTRUCTION, {}, (e) =>
      hostedEvents.push(e),
    );
    expect(paused.waiting).not.toBeNull();
    await hosted.agent.resume(hostedSession.id, paused.waiting as string, "approved", {}, (e) =>
      hostedEvents.push(e),
    );
    const hostedArchive = (await hosted.agent.listActivity("ws-fake")).find(
      (r) => r.tool === "archive_threads",
    );
    await hosted.agent.undo(hostedArchive?.id as string, hostedSession.id);
    const hostedRows = (await hosted.agent.listActivity("ws-fake")).map(comparable);
    expect(hostedRows.map((r) => r.tool)).toEqual(["undo", "archive_threads", "search_threads"]);

    // Now Claude Code: a local Session, monday's tools over the real stdio transport,
    // the fake `claude` replaying the recorded stream and calling them for real.
    const local = hostOverFakes();
    const session = await local.agent.createSession("ws-fake", {
      kind: "local",
      cli: "claude-code",
    });
    const { client } = await mcpOverStdio(local.agent, "ws-fake", session.id);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("archive_threads");
    const runner = fakeProcessRunner({ claude: claudeCodeOverMcp(fixtureLines(), client) });
    const adapter = createClaudeCodeSession({
      runner: runner.runner,
      link: hostSessionLink(local.agent),
      mcp: { url: "http://127.0.0.1:0/mcp/local", token: "device-token" },
      settings: () => ({
        command: "claude",
        model: "",
        toolTimeoutSeconds: 3600,
        systemPrompt: settings.systemPrompt,
      }),
      now: () => NOW,
    });
    await adapter.start(await local.agent.startContext(session.id, { developerMode: false }));
    expect(adapter.runtime().model).toBe("claude-sonnet-5");

    // The turn pauses at the preview: 12 Threads is above the threshold of 10, nothing moved.
    const events: AgentEvent[] = [];
    const first = await adapter.send(INSTRUCTION, (e) => events.push(e));
    expect(first.waiting).not.toBeNull();
    const waiting = events.find((e) => e.kind === "tool" && e.call.status === "waiting");
    if (waiting?.kind !== "tool") throw new Error("no waiting card");
    expect(waiting.call).toMatchObject({
      tool: "archive_threads",
      tier: "reversible",
      inputSummary: "12 threads",
    });
    expect(waiting.preview).toMatchObject({ kind: "threads", action: "Archive", count: 12 });
    expect(local.host.intents).toHaveLength(0);
    expect(
      events.some(
        (e) =>
          e.kind === "text" &&
          e.text === "Found 12 newsletters older than a week. Archiving them now.",
      ),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "done", waiting: waiting.call.id });

    // Apply from the card: the MCP call returns, the CLI's stream runs to its result.
    const more: AgentEvent[] = [];
    const second = await adapter.resume(waiting.call.id, "approved", (e) => more.push(e));
    expect(second.waiting).toBeNull();
    const oldIds = Array.from({ length: 12 }, (_, i) => `nl-old-${i + 1}`);
    expect(oldIds.every((id) => local.host.threads.get(id)?.archived)).toBe(true);
    expect(local.host.threads.get("nl-new-1")?.archived).toBe(false);
    const applied = [...more]
      .reverse()
      .find((e) => e.kind === "tool" && e.call.tool === "archive_threads");
    expect(applied && applied.kind === "tool" ? applied.call : null).toMatchObject({
      status: "done",
      approvedBy: "user",
      undoable: true,
      result: "Archive: 12 threads.",
    });
    expect(
      more.some(
        (e) =>
          e.kind === "text" &&
          e.text === "Archived all 12 newsletters older than a week (up to 2026-09-12).",
      ),
    ).toBe(true);

    // Undo restores every one of them, as the user, through the same path.
    const archive = (await local.agent.listActivity("ws-fake")).find(
      (r) => r.tool === "archive_threads",
    );
    const undone = await local.agent.undo(archive?.id as string, session.id);
    expect(undone.result).toBe("Undone: 12 of 12 threads restored.");
    expect(oldIds.every((id) => local.host.threads.get(id)?.archived === false)).toBe(true);
    expect(
      local.host.intents.filter((i) => i.kind === "unarchive" && i.actor === "user"),
    ).toHaveLength(12);

    // The done-when: the Activity rows equal the Hosted runtime's for the same fixture.
    const localRows = (await local.agent.listActivity("ws-fake")).map(comparable);
    expect(localRows).toEqual(hostedRows);
    expect(localRows.find((r) => r.tool === "archive_threads")).toMatchObject({
      tier: "reversible",
      status: "done",
      decision: "approved",
      approvedBy: "user",
      undoable: false,
      undoneAt: NOW.toISOString(),
      inputSummary: "12 threads",
      result: "Archive: 12 threads.",
      actor: "agent",
      input: { thread_ids: oldIds },
    });
    expect(localRows.find((r) => r.tool === "search_threads")).toMatchObject({
      tier: "read-only",
      decision: "auto",
      inputSummary: '"newsletter" · older than 7 days',
    });
    // And the Session's transcript shows the same cards in the same final states.
    const localTranscript = (await local.agent.getSession(session.id))?.events ?? [];
    const hostedTranscript = (await hosted.agent.getSession(hostedSession.id))?.events ?? [];
    expect(cards(localTranscript)).toEqual(cards(hostedTranscript));
    expect(cards(localTranscript)).toEqual([
      ["search_threads", "done"],
      ["archive_threads", "done"],
      ["undo", "done"],
    ]);
    expect(
      localTranscript
        .filter((e) => e.kind === "text")
        .map((e) => (e.kind === "text" ? e.text : "")),
    ).toEqual(
      hostedTranscript
        .filter((e) => e.kind === "text")
        .map((e) => (e.kind === "text" ? e.text : "")),
    );
    await adapter.cancel();
    await client.close();
  });
});

/* ------------------------------ Live, opt-in ------------------------------ */

const claudeOnPath = Bun.which("claude");
const live = process.env.MONDAY_LIVE_CLI === "1" && claudeOnPath !== null;

/** A ProcessRunner over Bun.spawn, for the live test only: the app spawns through Tauri. */
function bunProcessRunner(): ProcessRunner {
  return async (command, options): Promise<Process> => {
    const binary = command === "claude" ? (claudeOnPath ?? "claude") : command;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(options.env ?? {}),
    };
    // The recording machine runs inside Claude Code; the child must not think it is nested.
    for (const key of Object.keys(env)) if (key.startsWith("CLAUDE")) delete env[key];
    const child = Bun.spawn([binary, ...options.args], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Set<(line: string) => void>();
    const stderr = new Set<(line: string) => void>();
    const pump = async (
      stream: ReadableStream<Uint8Array>,
      listeners: Set<(line: string) => void>,
    ) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at = buffer.indexOf("\n");
        while (at >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          for (const l of listeners) l(line);
          at = buffer.indexOf("\n");
        }
      }
    };
    void pump(child.stdout, stdout);
    void pump(child.stderr, stderr);
    return {
      pid: child.pid,
      exited: child.exited.then((code) => code),
      onStdout: (l) => {
        stdout.add(l);
        return () => stdout.delete(l);
      },
      onStderr: (l) => {
        stderr.add(l);
        return () => stderr.delete(l);
      },
      write: async (text) => {
        child.stdin.write(text);
        child.stdin.flush();
      },
      kill: async () => {
        child.kill();
      },
    };
  };
}

describe.skipIf(!live)("the user's installed Claude Code (MONDAY_LIVE_CLI=1)", () => {
  test("archive every newsletter older than a week works through the installed claude over the loopback endpoint", async () => {
    const { agent, host } = hostOverFakes();
    const session = await agent.createSession("ws-fake", { kind: "local", cli: "claude-code" });
    // The Sidecar's routes on a loopback port; no auth middleware here, the fakes stand for Postgres.
    const app = agentRoutes(agent);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    try {
      const adapter = createClaudeCodeSession({
        runner: bunProcessRunner(),
        link: hostSessionLink(agent),
        mcp: { url: `http://127.0.0.1:${server.port}/mcp/local`, token: "device-token" },
        settings: () => ({
          command: "claude",
          model: "sonnet",
          toolTimeoutSeconds: 600,
          systemPrompt:
            "You are monday, an email assistant. Use the monday tools. Search first, then archive what matches. Be brief.",
        }),
        log: (line) => console.error(line),
      });
      await adapter.start(await agent.startContext(session.id, { developerMode: false }));
      const events: AgentEvent[] = [];
      const first = await adapter.send(INSTRUCTION, (e) => events.push(e));
      expect(first.waiting).not.toBeNull();
      const waiting = events.find((e) => e.kind === "tool" && e.call.status === "waiting");
      expect(waiting && waiting.kind === "tool" ? waiting.call.tool : null).toBe("archive_threads");
      expect(host.intents).toHaveLength(0);
      const second = await adapter.resume(first.waiting as string, "approved", (e) =>
        events.push(e),
      );
      expect(second.waiting).toBeNull();
      expect(host.intents.filter((i) => i.kind === "archive")).toHaveLength(12);
      const log = await agent.listActivity("ws-fake");
      expect(log.find((r) => r.tool === "archive_threads")).toMatchObject({
        status: "done",
        decision: "approved",
        undoable: true,
      });
      await adapter.cancel();
    } finally {
      server.stop(true);
    }
  }, 180_000);
});

export type { ApprovalDecision, ToolCall };
