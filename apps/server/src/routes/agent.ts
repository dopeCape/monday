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

import type { AgentEvent, TurnContext } from "@monday/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import type { AgentHost } from "../intelligence/agent/index.ts";
import { parseBody } from "./validate.ts";

const workspaceBody = z.object({ workspace: z.string().min(1) });
const context = z
  .object({
    pinned: z.array(z.string().min(1)).max(500).optional(),
    threadId: z.string().min(1).nullable().optional(),
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
    return c.json(await agent.createSession(body.data.workspace), 201);
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
