// The Agent host for Sessions a Local runtime drives (slice 15, ADR 0002):
// monday's tools over MCP with tiers in the listing, a call above the free
// tier that blocks until the composer's approval resumes it, the live stream
// of its cards, the Activity rows equal to what the Hosted loop writes for
// the same fixture, the routes a Device uses (a local Session, appended
// events, the runtime switch, the loopback endpoint over streamable HTTP),
// the stdio launcher's proxy, and the handover when a Session switches
// Runtime mid-way.

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ActivityRecord, AgentEvent, SessionSummary } from "@monday/shared";
import { Hono } from "hono";
import { createMcpProxy, mcpHeaders, parseMcpArgs } from "../entry/mcp.ts";
import type { AppEnv } from "../src/auth/middleware.ts";
import {
  type AgentHost,
  createAgentHost,
  createMemoryActivityLog,
  createMemorySessionStore,
  createMondayMcpServer,
} from "../src/intelligence/agent/index.ts";
import {
  createFakeToolHost,
  type FakeThreadInput,
} from "../src/intelligence/agent/tools/fake-host.ts";
import { createFakeRuntime, type FakeStep } from "../src/intelligence/runtime/fake/index.ts";
import type { AgentMessage } from "../src/intelligence/runtime/index.ts";
import { agentRoutes } from "../src/routes/agent.ts";

const NOW = new Date("2026-09-17T10:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

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
  return [...old, ...fresh];
}

const settings = {
  systemPrompt: "You are monday.",
  maxSteps: 24,
  previewAbove: 10,
  alwaysAsk: [] as string[],
  searchLimit: 100,
};

function hostOverFakes(steps: FakeStep[] = []) {
  const { runtime, converse } = createFakeRuntime({ steps, now: () => NOW.getTime() });
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
  return { agent, host, activity, sessions, converse };
}

const idsOf = (messages: AgentMessage[]): string[] => {
  const tool = [...messages]
    .reverse()
    .find((m) => m.role === "tool" && m.name === "search_threads");
  if (tool?.role !== "tool") return [];
  return (JSON.parse(tool.content.slice(tool.content.indexOf("["))) as { id: string }[]).map(
    (t) => t.id,
  );
};

/** An Activity row without what differs between two runs: ids, the call id, the Session, the time. */
export function comparable(row: ActivityRecord) {
  const { id: _id, callId: _c, sessionId: _s, at: _at, ...rest } = row;
  return rest;
}

async function connected(agent: AgentHost, sessionId: string | null) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createMondayMcpServer(agent, { workspaceId: "ws-fake", sessionId });
  await server.connect(serverSide);
  const client = new Client({ name: "test-cli", version: "0.0.0" });
  await client.connect(clientSide);
  return { client, server };
}

describe("monday's tools over MCP for a Local runtime", () => {
  test("the listing carries the tiers and a read tool answers at once", async () => {
    const { agent, activity } = hostOverFakes();
    const session = await agent.createSession("ws-fake", { kind: "local", cli: "claude-code" });
    expect(session.runtime).toEqual({ kind: "local", cli: "claude-code" });
    const { client } = await connected(agent, session.id);
    const listed = await client.listTools();
    const send = listed.tools.find((t) => t.name === "send_draft");
    expect(send?.annotations?.destructiveHint).toBe(true);
    expect(send?._meta?.tier).toBe("leaves_mailbox");
    const result = await client.callTool({
      name: "search_threads",
      arguments: { section: "newsletters", older_than_days: 7 },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text.startsWith("12 threads:")).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(activity.rows[0]).toMatchObject({
      tool: "search_threads",
      tier: "read-only",
      status: "done",
      decision: "auto",
      sessionId: session.id,
    });
    // The card reached the Session's transcript, as the Hosted loop's would.
    const events = (await agent.getSession(session.id))?.events ?? [];
    expect(events.map((e) => e.kind)).toEqual(["tool"]);
  });

  test("a batch above the threshold blocks the MCP call until the composer approves, and the rows equal the Hosted loop's", async () => {
    // The Hosted loop first, for the rows to compare against.
    const hosted = hostOverFakes([
      {
        toolCalls: [
          {
            id: "h1",
            name: "search_threads",
            args: { section: "newsletters", older_than_days: 7 },
          },
        ],
      },
      (call) => ({
        toolCalls: [
          { id: "h2", name: "archive_threads", args: { thread_ids: idsOf(call.messages) } },
        ],
      }),
      "Archived 12 newsletters older than a week.",
    ]);
    const hostedSession = await hosted.agent.createSession("ws-fake");
    const first = await hosted.agent.turn(
      hostedSession.id,
      "archive every newsletter older than a week",
      {},
      () => {},
    );
    await hosted.agent.resume(hostedSession.id, first.waiting as string, "approved", {}, () => {});
    const hostedRows = (await hosted.agent.listActivity("ws-fake")).map(comparable);

    // Now the same calls over MCP, as a CLI makes them.
    const { agent, host } = hostOverFakes();
    const session = await agent.createSession("ws-fake", { kind: "local", cli: "claude-code" });
    const live: AgentEvent[] = [];
    const stop = agent.live(session.id, (e) => live.push(e));
    const { client } = await connected(agent, session.id);
    await client.callTool({
      name: "search_threads",
      arguments: { section: "newsletters", older_than_days: 7 },
    });
    const ids = Array.from({ length: 12 }, (_, i) => `nl-old-${i + 1}`);
    const call = client.callTool({ name: "archive_threads", arguments: { thread_ids: ids } });

    // The call waits: the live stream showed the card, nothing moved.
    const waiting = await new Promise<AgentEvent>((resolve) => {
      const check = () => {
        const w = live.find((e) => e.kind === "tool" && e.call.status === "waiting");
        if (w) resolve(w);
        else setTimeout(check, 5);
      };
      check();
    });
    if (waiting.kind !== "tool") throw new Error("no waiting card");
    expect(waiting.call).toMatchObject({ tool: "archive_threads", tier: "reversible" });
    expect(waiting.preview).toMatchObject({ kind: "threads", action: "Archive", count: 12 });
    expect(host.intents).toHaveLength(0);
    // A turn for a local Session is refused on the Server: the Device drives it.
    await expect(agent.turn(session.id, "hi", {}, () => {})).rejects.toMatchObject({
      name: "LocalSessionError",
      status: 409,
    });

    // Approve from the card: the same resume the Hosted loop uses.
    const resumed: AgentEvent[] = [];
    const outcome = await agent.resume(session.id, waiting.call.id, "approved", {}, (e) =>
      resumed.push(e),
    );
    expect(outcome.waiting).toBeNull();
    expect(resumed.map((e) => e.kind)).toEqual(["tool", "done"]);
    const result = await call;
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe("Archive: 12 threads.");
    expect(result._meta).toMatchObject({ activityId: waiting.call.id, tier: "reversible" });
    expect(ids.every((id) => host.threads.get(id)?.archived)).toBe(true);
    stop();

    const localRows = (await agent.listActivity("ws-fake")).map(comparable);
    expect(localRows).toEqual(hostedRows);
    expect(localRows.find((r) => r.tool === "archive_threads")).toMatchObject({
      status: "done",
      decision: "approved",
      approvedBy: "user",
      undoable: true,
      actor: "agent",
    });

    // Undo restores every one of them, through the same path.
    const archive = (await agent.listActivity("ws-fake")).find((r) => r.tool === "archive_threads");
    const undone = await agent.undo(archive?.id as string, session.id);
    expect(undone.result).toBe("Undone: 12 of 12 threads restored.");
    expect(ids.every((id) => host.threads.get(id)?.archived === false)).toBe(true);
    const transcript = (await agent.getSession(session.id))?.events ?? [];
    expect(
      transcript.map((e) => (e.kind === "tool" ? [e.call.tool, e.call.status] : e.kind)),
    ).toEqual([
      ["search_threads", "done"],
      ["archive_threads", "done"],
      ["undo", "done"],
    ]);
  });

  test("a decision that arrives before the call registers its wait still lands", async () => {
    const { agent, host } = hostOverFakes();
    const session = await agent.createSession("ws-fake", { kind: "local", cli: "codex" });
    const { client } = await connected(agent, session.id);
    const ids = Array.from({ length: 12 }, (_, i) => `nl-old-${i + 1}`);
    let waitingId = "";
    const stop = agent.live(session.id, (e) => {
      if (e.kind === "tool" && e.call.status === "waiting" && !waitingId) {
        waitingId = e.call.id;
        // Decline synchronously from inside the listener, before `ask` runs.
        void agent.resume(session.id, waitingId, "declined", {}, () => {});
      }
    });
    const result = await client.callTool({ name: "trash_threads", arguments: { thread_ids: ids } });
    stop();
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain("Declined by the user");
    expect(host.threads.get("nl-old-1")?.deleted).toBe(false);
  });
});

describe("the routes a Device uses for a local Session", () => {
  const appOver = (agent: AgentHost) => {
    const app = new Hono<AppEnv>();
    app.route("/", agentRoutes(agent));
    return app;
  };
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

  test("a local Session, appended events, the runtime switch line and the live stream", async () => {
    const { agent } = hostOverFakes();
    const app = appOver(agent);
    const created = await app.request(
      "/sessions",
      json("POST", { workspace: "ws-fake", runtime: { kind: "local", cli: "opencode" } }),
    );
    expect(created.status).toBe(201);
    const session = (await created.json()) as SessionSummary;
    expect(session.runtime).toEqual({ kind: "local", cli: "opencode" });

    const appended = await app.request(
      `/sessions/${session.id}/events`,
      json("POST", { event: { kind: "user", id: "u1", text: "archive old newsletters" } }),
    );
    expect(appended.status).toBe(200);
    // A Device may append a Developer mode built-in card, never a monday tool card.
    const refused = await app.request(
      `/sessions/${session.id}/events`,
      json("POST", {
        event: {
          kind: "tool",
          call: {
            id: "x",
            sessionId: null,
            runId: null,
            tool: "archive_threads",
            tier: "reversible",
            inputSummary: "",
            status: "done",
            approvedBy: null,
            undoable: false,
          },
          preview: null,
        },
      }),
    );
    expect(refused.status).toBe(400);

    const switched = await app.request(
      `/sessions/${session.id}/runtime`,
      json("PATCH", { runtime: { kind: "local", cli: "claude-code", model: "claude-opus-5" } }),
    );
    expect(switched.status).toBe(200);
    expect((await switched.json()) as AgentEvent).toMatchObject({
      kind: "runtime",
      runtime: { kind: "local", cli: "claude-code", model: "claude-opus-5" },
    });
    const loaded = (await (await app.request(`/sessions/${session.id}`)).json()) as {
      session: SessionSummary;
      events: AgentEvent[];
    };
    expect(loaded.session.runtime).toEqual({
      kind: "local",
      cli: "claude-code",
      model: "claude-opus-5",
    });
    expect(loaded.session.title).toBe("archive old newsletters");
    expect(loaded.events.map((e) => e.kind)).toEqual(["user", "runtime"]);

    // The live stream carries the cards of MCP calls as they happen.
    const res = await app.request(`/sessions/${session.id}/live`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no stream");
    await agent.call({
      workspaceId: "ws-fake",
      sessionId: session.id,
      name: "search_threads",
      args: { section: "newsletters" },
    });
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("event: tool");
    expect(text).toContain('"tool":"search_threads"');
    await reader.cancel();
  });

  test("the loopback endpoint speaks streamable HTTP and attributes calls by header", async () => {
    const { agent, activity } = hostOverFakes();
    const app = appOver(agent);
    const session = await agent.createSession("ws-fake", { kind: "local", cli: "claude-code" });
    const missing = await app.request("/mcp/local", json("POST", {}));
    expect(missing.status).toBe(400);

    const args = parseMcpArgs([
      "--port",
      "1",
      "--token",
      "t",
      "--workspace",
      "ws-fake",
      "--session",
      session.id,
    ]);
    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:1/mcp/local"), {
      requestInit: { headers: mcpHeaders(args) },
      fetch: (input, init) => app.request(input instanceof Request ? input : String(input), init),
    }) as unknown as Transport;
    const client = new Client({ name: "cli", version: "0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("archive_threads");
    const result = await client.callTool({
      name: "archive_threads",
      arguments: { thread_ids: ["nl-old-1", "nl-old-2"] },
    });
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe("Archive: 2 threads.");
    expect(activity.rows.at(-1)).toMatchObject({
      tool: "archive_threads",
      sessionId: session.id,
      status: "done",
    });
    await client.close();
  });

  test("the stdio launcher parses its flags and proxies to the upstream client", async () => {
    expect(() => parseMcpArgs([])).toThrow(/usage/);
    expect(
      parseMcpArgs(["--port=4242", "--token", "abc", "--workspace", "ws", "--pinned", "a.b, c.d"]),
    ).toEqual({
      port: 4242,
      token: "abc",
      workspace: "ws",
      session: null,
      pinned: ["a.b", "c.d"],
    });
    expect(
      parseMcpArgs([], {
        MONDAY_SIDECAR_PORT: "7",
        MONDAY_SIDECAR_TOKEN: "t",
        MONDAY_WORKSPACE: "w",
      }),
    ).toMatchObject({ port: 7, token: "t", workspace: "w" });
    expect(mcpHeaders(parseMcpArgs(["--port", "1", "--token", "t", "--workspace", "w"]))).toEqual({
      authorization: "Bearer t",
      "x-monday-workspace": "w",
    });

    const { agent } = hostOverFakes();
    const { client: upstream } = await connected(agent, null);
    const proxy = createMcpProxy(upstream);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await proxy.connect(serverSide);
    const cli = new Client({ name: "stdio-cli", version: "0" });
    await cli.connect(clientSide);
    expect((await cli.listTools()).tools.map((t) => t.name)).toContain("search_threads");
    const result = await cli.callTool({
      name: "search_threads",
      arguments: { section: "newsletters" },
    });
    expect((result.content as Array<{ text: string }>)[0]?.text.startsWith("14 threads:")).toBe(
      true,
    );
  });
});

describe("a Runtime switch mid-Session", () => {
  test("the next Hosted turn carries the transcript the Local runtime produced, and tool calls are not repeated", async () => {
    const { agent, converse } = hostOverFakes(["Right, they are archived already."]);
    const session = await agent.createSession("ws-fake", { kind: "local", cli: "claude-code" });
    await agent.appendEvent(session.id, {
      kind: "user",
      id: "u1",
      text: "archive old newsletters",
    });
    await agent.call({
      workspaceId: "ws-fake",
      sessionId: session.id,
      name: "archive_threads",
      args: { thread_ids: ["nl-old-1", "nl-old-2"] },
    });
    await agent.appendEvent(session.id, {
      kind: "text",
      id: "t1",
      text: "Archived 2 newsletters.",
    });
    const line = await agent.switchRuntime(session.id, {
      kind: "hosted",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(line.kind).toBe("runtime");

    const events: AgentEvent[] = [];
    const result = await agent.turn(session.id, "did you archive them?", {}, (e) => events.push(e));
    expect(result.waiting).toBeNull();
    const prompt = converse.calls[0]?.messages[0];
    expect(prompt?.role).toBe("user");
    const content = prompt?.role === "user" ? prompt.content : "";
    expect(content.startsWith("The conversation so far, from another runtime.")).toBe(true);
    expect(content).toContain("User: archive old newsletters");
    expect(content).toContain("Tool archive_threads (2 threads): Archive: 2 threads.");
    expect(content).toContain("Assistant: Archived 2 newsletters.");
    expect(content.endsWith("The user continues:\ndid you archive them?")).toBe(true);
    // The transcript shows the switch as a line between the two runtimes' turns.
    const transcript = (await agent.getSession(session.id))?.events ?? [];
    expect(transcript.map((e) => e.kind)).toEqual([
      "user",
      "tool",
      "text",
      "runtime",
      "user",
      "text",
      "done",
    ]);
    // A second turn on the same epoch does not hand over again.
    converse.script("Yes.");
    await agent.turn(session.id, "sure?", {}, () => {});
    const second = converse.calls[1]?.messages.at(-1);
    expect(second?.role === "user" ? second.content : "").toBe("sure?");
  });
});
