// The Agent host routes (docs/spec/architecture.md, "API shape"; ADR 0002).
//   GET  /sessions?workspace=                      {sessions: SessionSummary[]}, newest first
//   POST /sessions                {workspace}      -> SessionSummary (201)
//   GET  /sessions/:id                             {session, events}: the transcript, cards in their latest state
//   POST /sessions/:id/turns      {text, context?} text/event-stream of AgentEvent until done
//   POST /sessions/:id/approvals/:activityId {decision, context?}   the same stream, resuming the paused turn
//   GET  /activity?workspace=&limit=&session=      {activity: ActivityRecord[]}, newest first
//   POST /activity/:id/undo       {session?}       -> the undo's ActivityRecord
//   GET  /agent/tools                              {tools}: the MCP listing with tiers
// A turn streams over SSE on the POST itself: runtime-neutral (Hono's
// streamSSE runs on Bun, Node, Vercel and Netlify alike), no second
// connection to pair with the WebSocket, and a paused turn simply ends its
// stream with `done {waiting}`; the approval opens the next one.
//
// Slice 15, for a Session a Device's Local runtime drives (its runtime is
// `{kind: "local"}`; the Device spawns the CLI and persists what it says):
//   POST /sessions                {workspace, runtime}  a Session on that Runtime
//   PATCH /sessions/:id/runtime   {runtime}        -> the `runtime` event the thread shows
//   POST /sessions/:id/events     {event}          appends one transcript event (user, text, error)
//   GET  /sessions/:id/live                        text/event-stream of the tool cards the
//                                                  Server produces for the Session as MCP calls run
//   ALL  /mcp/local                                monday's tools over MCP streamable HTTP on loopback;
//                                                  bearer = the Device token, X-Monday-Workspace and
//                                                  X-Monday-Session say whose cards they are

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AgentEvent, Runtime, TurnContext } from "@monday/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { type AgentHost, createMondayMcpServer } from "../intelligence/agent/index.ts";
import { parseBody } from "./validate.ts";

const runtimeSchema: z.ZodType<Runtime> = z.union([
  z.object({
    kind: z.literal("local"),
    cli: z.enum(["claude-code", "codex", "opencode"]),
    model: z.string().optional(),
  }),
  z.object({
    kind: z.literal("hosted"),
    provider: z.enum(["anthropic", "gemini", "openai", "kimi", "openrouter"]),
    model: z.string().min(1),
  }),
]);
const workspaceBody = z.object({
  workspace: z.string().min(1),
  runtime: runtimeSchema.optional(),
});
const runtimeBody = z.object({ runtime: runtimeSchema });
const toolCallSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().nullable(),
  runId: z.string().nullable(),
  tool: z.string().min(1),
  tier: z.enum(["always-ask", "reversible", "read-only"]),
  inputSummary: z.string(),
  status: z.enum(["running", "done", "failed", "waiting"]),
  approvedBy: z.enum(["user", "standing"]).nullable(),
  result: z.string().optional(),
  undoable: z.boolean(),
  undoneAt: z.string().nullable().optional(),
  declined: z.boolean().optional(),
  builtin: z.boolean().optional(),
});
/** What a Device may append: what its CLI said, never a card the Server owns. */
const eventBody = z.object({
  event: z.union([
    z.object({ kind: z.literal("user"), id: z.string().min(1), text: z.string().min(1) }),
    z.object({ kind: z.literal("text"), id: z.string().min(1), text: z.string() }),
    z.object({
      kind: z.literal("error"),
      id: z.string().min(1),
      message: z.string(),
      code: z.string().optional(),
    }),
    z.object({
      kind: z.literal("tool"),
      call: toolCallSchema.extend({ builtin: z.literal(true) }),
      preview: z.object({ kind: z.literal("text"), text: z.string() }).nullable(),
    }),
  ]),
});
const context = z
  .object({
    pinned: z.array(z.string().min(1)).max(500).optional(),
    threadId: z.string().min(1).nullable().optional(),
    developerMode: z.boolean().optional(),
  })
  .optional();
const turnBody = z.object({ text: z.string().min(1).max(20_000), context });
const approvalBody = z.object({ decision: z.enum(["approved", "declined"]), context });
const undoBody = z.object({ session: z.string().min(1).optional() }).optional();
const activityQuery = z.object({
  workspace: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  session: z.string().min(1).optional(),
});

export function agentRoutes(agent: AgentHost): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/sessions", async (c) => {
    const workspace = c.req.query("workspace");
    if (!workspace) return c.json({ error: "workspace_required" }, 400);
    return c.json({ sessions: await agent.listSessions(workspace) });
  });

  app.post("/sessions", async (c) => {
    const body = await parseBody(c, workspaceBody);
    if (!body.ok) return body.response;
    return c.json(await agent.createSession(body.data.workspace, body.data.runtime), 201);
  });

  app.patch("/sessions/:id/runtime", async (c) => {
    const body = await parseBody(c, runtimeBody);
    if (!body.ok) return body.response;
    const found = await agent.getSession(c.req.param("id"));
    if (!found) return c.json({ error: "not_found" }, 404);
    return c.json(await agent.switchRuntime(found.session.id, body.data.runtime));
  });

  app.post("/sessions/:id/events", async (c) => {
    const body = await parseBody(c, eventBody);
    if (!body.ok) return body.response;
    const found = await agent.getSession(c.req.param("id"));
    if (!found) return c.json({ error: "not_found" }, 404);
    await agent.appendEvent(found.session.id, body.data.event as AgentEvent);
    return c.json({ ok: true });
  });

  app.get("/sessions/:id/live", async (c) => {
    const found = await agent.getSession(c.req.param("id"));
    if (!found) return c.json({ error: "not_found" }, 404);
    const sessionId = found.session.id;
    return streamSSE(c, async (stream) => {
      let chain = Promise.resolve();
      const unsubscribe = agent.live(sessionId, (event) => {
        chain = chain.then(() =>
          stream.writeSSE({ event: event.kind, data: JSON.stringify(event) }).catch(() => {}),
        );
      });
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
        c.req.raw.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      unsubscribe();
      await chain;
    });
  });

  app.all("/mcp/local", async (c) => {
    const workspaceId = c.req.header("x-monday-workspace");
    if (!workspaceId) return c.json({ error: "workspace_required" }, 400);
    const sessionId = c.req.header("x-monday-session") || null;
    const pinnedHeader = c.req.header("x-monday-pinned");
    const pinned = pinnedHeader
      ? pinnedHeader
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean)
      : undefined;
    // Stateless: no MCP session id, one server per request, the JSON answer once the tool returns.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = createMondayMcpServer(agent, { workspaceId, sessionId, pinned });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close().catch(() => {});
    }
  });

  app.get("/sessions/:id", async (c) => {
    const found = await agent.getSession(c.req.param("id"));
    if (!found) return c.json({ error: "not_found" }, 404);
    return c.json(found);
  });

  /** Runs `drive` while streaming every event it produces as one SSE message. */
  const streamTurn = (
    c: Parameters<typeof streamSSE>[0],
    drive: (onEvent: (event: AgentEvent) => void) => Promise<unknown>,
  ) =>
    streamSSE(c, async (stream) => {
      let chain = Promise.resolve();
      const onEvent = (event: AgentEvent) => {
        chain = chain.then(() =>
          stream.writeSSE({ event: event.kind, data: JSON.stringify(event) }).catch(() => {}),
        );
      };
      try {
        await drive(onEvent);
      } catch (error) {
        onEvent({
          kind: "error",
          id: crypto.randomUUID(),
          message: error instanceof Error ? error.message : String(error),
          code: error instanceof Error && "status" in error ? error.name : undefined,
        });
        onEvent({ kind: "done", id: crypto.randomUUID(), waiting: null });
      }
      await chain;
    });

  app.post("/sessions/:id/turns", async (c) => {
    const body = await parseBody(c, turnBody);
    if (!body.ok) return body.response;
    const session = await agent.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "not_found" }, 404);
    const ctx: TurnContext = body.data.context ?? {};
    return streamTurn(c, (onEvent) => agent.turn(session.session.id, body.data.text, ctx, onEvent));
  });

  app.post("/sessions/:id/approvals/:activityId", async (c) => {
    const body = await parseBody(c, approvalBody);
    if (!body.ok) return body.response;
    const session = await agent.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "not_found" }, 404);
    const ctx: TurnContext = body.data.context ?? {};
    const activityId = c.req.param("activityId");
    return streamTurn(c, (onEvent) =>
      agent.resume(session.session.id, activityId, body.data.decision, ctx, onEvent),
    );
  });

  app.get("/activity", async (c) => {
    const parsed = activityQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_query", issues: parsed.error.issues }, 400);
    }
    const q = parsed.data;
    return c.json({
      activity: await agent.listActivity(q.workspace, {
        limit: q.limit,
        ...(q.session ? { sessionId: q.session } : {}),
      }),
    });
  });

  app.post("/activity/:id/undo", async (c) => {
    const body = await parseBody(c, undoBody);
    if (!body.ok) return body.response;
    return c.json(await agent.undo(c.req.param("id"), body.data?.session ?? null));
  });

  app.get("/agent/tools", async (c) => {
    const workspace = c.req.query("workspace");
    if (!workspace) return c.json({ error: "workspace_required" }, 400);
    return c.json({ tools: agent.tools(workspace).mcpTools() });
  });

  return app;
}
