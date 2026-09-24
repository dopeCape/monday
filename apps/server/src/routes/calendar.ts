// The calendar routes (slice 18) over the calendar module. Header reads work
// on a locked Server; content reads (titles) answer 423 Locked.
//   GET    /calendar/info?workspace=                           {source, providerSendsInvites, meetingLinks, ...}
//   GET    /calendars?workspace=                               {calendars}
//   PUT    /calendars/:id/visible                              {visible}
//   PUT    /accounts/:id/caldav                                {url, user, password} or null to unlink
//   GET    /calendar/events?workspace=&from=&to=               decrypted Events in the window, masters included (423 locked)
//   POST   /calendar/events/content                            {workspace, ids} -> {events: [{id, title, description, location}]}
//   GET    /calendar/events/:id
//   POST   /calendar/events                                    {workspace, ...EventInput}
//   PUT    /calendar/events/:id                                Partial<EventInput> & {scope?, occurrence?}
//   DELETE /calendar/events/:id?scope=&occurrence=             a recurring one aimed at this, following or all
//   GET    /calendar/status?workspace=                         {status}: whether the calendar can be read, and why not
//   POST   /calendar/sync                                      {workspace} -> {status}: read it again now
//   POST   /calendar/events/:id/respond                        {response}
//   GET    /calendar/busy?workspace=&from=&to=                 own busy slots
//   GET    /threads/:id/invites                                {invites}
//   GET    /invites/:id
//   POST   /invites/:id/rsvp                                   {at, actor, response}   the Outbox intent
//   POST   /webhooks/calendar/:accountId?token=                Google channel or Graph subscription delivery (public)

import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import {
  type CalendarModule,
  CalendarUnavailableError,
  classifyCalendarError,
} from "../calendar/index.ts";
import { ProviderError } from "../providers/types.ts";
import { parseBody } from "./validate.ts";

const person = z.object({ name: z.string().default(""), email: z.string().min(3) });
const meetingLink = z.enum(["none", "google-meet", "teams", "jitsi", "custom"]);
const rsvp = z.enum(["accepted", "tentative", "declined", "needs-action"]);

const eventFields = {
  calendarId: z.string().min(1).nullable().optional(),
  title: z.string().max(500),
  description: z.string().max(20_000).optional(),
  location: z.string().max(1000).optional(),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  allDay: z.boolean().optional(),
  timeZone: z.string().max(64).nullable().optional(),
  attendees: z.array(person).max(500).optional(),
  meetingLink: meetingLink.optional(),
  customLink: z.string().url().nullable().optional(),
  recurrence: z.string().max(4000).nullable().optional(),
  reminders: z.array(z.int().min(0).max(40320)).max(5).nullable().optional(),
};
const scope = z.enum(["this", "following", "all"]);
const aim = {
  scope: scope.optional(),
  occurrence: z.iso.datetime({ offset: true }).optional(),
};

const createBody = z.object({ workspace: z.string().min(1), ...eventFields });
const updateBody = z.object({ ...eventFields, ...aim }).partial();
const deleteQuery = z.object(aim);
const syncBody = z.object({ workspace: z.string().min(1) });
const windowQuery = z.object({
  workspace: z.string().min(1),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  calendars: z.string().optional(),
  cancelled: z.enum(["true", "false"]).optional(),
});
const workspaceQuery = z.object({ workspace: z.string().min(1) });
const contentBody = z.object({
  workspace: z.string().min(1),
  ids: z.array(z.string().min(1)).max(1000),
});
const visibleBody = z.object({ visible: z.boolean() });
const caldavBody = z
  .object({ url: z.string().url(), user: z.string().min(1), password: z.string().min(1) })
  .nullable();
const respondBody = z.object({ response: rsvp });
const rsvpBody = z.object({
  at: z.iso.datetime({ offset: true }),
  actor: z.enum(["user", "automation"]).default("user"),
  response: rsvp,
});

export function calendarRoutes(calendar: CalendarModule): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * A write the calendar refused, in words the screen can show: 409 when this
   * calendar cannot do it, 502 with the classified problem when the Provider said no.
   */
  const refused = (c: Context<AppEnv>, error: unknown) => {
    if (error instanceof CalendarUnavailableError) {
      return c.json({ error: "unavailable", message: error.reason }, 409);
    }
    if (error instanceof ProviderError) {
      const problem = classifyCalendarError(error, "google");
      return c.json({ error: "provider", message: problem.message, problem }, 502);
    }
    throw error;
  };

  app.get("/calendar/info", async (c) => {
    const q = workspaceQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query", issues: q.error.issues }, 400);
    return c.json(await calendar.info(q.data.workspace));
  });

  app.get("/calendars", async (c) => {
    const q = workspaceQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query", issues: q.error.issues }, 400);
    return c.json({ calendars: await calendar.listCalendars(q.data.workspace) });
  });

  app.put("/calendars/:id/visible", async (c) => {
    const body = await parseBody(c, visibleBody);
    if (!body.ok) return body.response;
    return c.json(await calendar.setCalendarVisible(c.req.param("id"), body.data.visible));
  });

  app.put("/accounts/:id/caldav", async (c) => {
    const body = await parseBody(c, caldavBody);
    if (!body.ok) return body.response;
    try {
      return c.json(await calendar.linkCalDav(c.req.param("id"), body.data));
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === "auth") return c.json({ error: "auth", message }, 401);
      if (code === "network") return c.json({ error: "network", message }, 502);
      if (code === "not-found" || code === "protocol") {
        return c.json({ error: "caldav", message }, 400);
      }
      throw error;
    }
  });

  app.get("/calendar/events", async (c) => {
    const q = windowQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query", issues: q.error.issues }, 400);
    const ids = q.data.calendars?.split(",").filter((s) => s.length > 0);
    return c.json({
      events: await calendar.listEvents(q.data.workspace, {
        from: q.data.from,
        to: q.data.to,
        ...(ids && ids.length > 0 ? { calendarIds: ids } : {}),
        includeCancelled: q.data.cancelled === "true",
      }),
    });
  });

  // Before /calendar/events/:id, so "content" is never read as an id.
  app.post("/calendar/events/content", async (c) => {
    const body = await parseBody(c, contentBody);
    if (!body.ok) return body.response;
    return c.json({ events: await calendar.eventsContent(body.data.workspace, body.data.ids) });
  });

  app.post("/calendar/events", async (c) => {
    const body = await parseBody(c, createBody);
    if (!body.ok) return body.response;
    const { workspace, ...input } = body.data;
    try {
      return c.json(await calendar.createEvent(workspace, input), 201);
    } catch (error) {
      return refused(c, error);
    }
  });

  app.get("/calendar/events/:id", async (c) => {
    const event = await calendar.readEvent(c.req.param("id"));
    return event ? c.json(event) : c.json({ error: "not_found" }, 404);
  });

  app.put("/calendar/events/:id", async (c) => {
    const body = await parseBody(c, updateBody);
    if (!body.ok) return body.response;
    const { scope: s, occurrence, ...patch } = body.data;
    try {
      return c.json(
        await calendar.updateEvent(c.req.param("id"), patch, {
          ...(s ? { scope: s } : {}),
          ...(occurrence ? { occurrence } : {}),
        }),
      );
    } catch (error) {
      return refused(c, error);
    }
  });

  app.delete("/calendar/events/:id", async (c) => {
    const q = deleteQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query", issues: q.error.issues }, 400);
    try {
      await calendar.deleteEvent(c.req.param("id"), {
        ...(q.data.scope ? { scope: q.data.scope } : {}),
        ...(q.data.occurrence ? { occurrence: q.data.occurrence } : {}),
      });
    } catch (error) {
      return refused(c, error);
    }
    return c.body(null, 204);
  });

  app.get("/calendar/status", async (c) => {
    const q = workspaceQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query", issues: q.error.issues }, 400);
    return c.json({ status: await calendar.status(q.data.workspace) });
  });

  app.post("/calendar/sync", async (c) => {
    const body = await parseBody(c, syncBody);
    if (!body.ok) return body.response;
    return c.json({ status: await calendar.syncNow(body.data.workspace) });
  });

  app.post("/calendar/events/:id/respond", async (c) => {
    const body = await parseBody(c, respondBody);
    if (!body.ok) return body.response;
    try {
      return c.json(await calendar.respond(c.req.param("id"), body.data.response));
    } catch (error) {
      return refused(c, error);
    }
  });

  app.get("/calendar/busy", async (c) => {
    const q = windowQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query", issues: q.error.issues }, 400);
    return c.json({ busy: await calendar.busy(q.data.workspace, q.data.from, q.data.to) });
  });

  app.get("/threads/:id/invites", async (c) =>
    c.json({ invites: await calendar.invitesOfThread(c.req.param("id")) }),
  );

  app.get("/invites/:id", async (c) => {
    const invite = await calendar.readInvite(c.req.param("id"));
    return invite ? c.json(invite) : c.json({ error: "not_found" }, 404);
  });

  app.post("/invites/:id/rsvp", async (c) => {
    const body = await parseBody(c, rsvpBody);
    if (!body.ok) return body.response;
    return c.json(
      await calendar.applyInviteIntent({
        kind: "invite.rsvp",
        inviteId: c.req.param("id"),
        ...body.data,
      }),
    );
  });

  // Google posts an empty body with the token in X-Goog-Channel-Token; Graph
  // posts a validation handshake first, then notifications carrying clientState.
  app.post("/webhooks/calendar/:accountId", async (c) => {
    const validation = c.req.query("validationToken");
    if (validation !== undefined) return c.text(validation, 200);
    let token = c.req.query("token") ?? c.req.header("x-goog-channel-token") ?? null;
    if (!token) {
      try {
        const body = (await c.req.json()) as { value?: { clientState?: string }[] };
        token = body.value?.[0]?.clientState ?? null;
      } catch {
        token = null;
      }
    }
    const ok = await calendar.webhook(c.req.param("accountId"), token);
    return ok ? c.body(null, 202) : c.json({ error: "forbidden" }, 403);
  });

  return app;
}
