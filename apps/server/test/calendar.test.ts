// The calendar module (slice 18) through its interface and the routes over
// the fake seams: a Google-shaped Account whose Provider calendar is synced,
// written and mails its own invitations; an IMAP-only Account on the Local
// calendar where monday mails iMIP itself; an invitation arriving in a
// Message on each, the invite bar's RSVP intent, and the feed rows that
// carry no titles.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, CalendarEvent, Change, Invite } from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { parseICalendar, writeICalendar } from "../src/calendar/ical.ts";
import { type CalendarModule, createCalendar } from "../src/calendar/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys } from "../src/crypto/keys.ts";
import {
  createFakeIntegrations,
  createFakeMcpClients,
  createIntelligence,
} from "../src/intelligence/index.ts";
import { createFakeChat, createFakeConverse } from "../src/intelligence/runtime/fake/index.ts";
import { createJobs, type Jobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { createCredentialStore } from "../src/providers/credentials.ts";
import {
  createFakeProvider,
  type FakeProvider,
  fakeCredentials,
  generateFixture,
} from "../src/providers/fake/index.ts";
import { createProviderRegistry } from "../src/providers/index.ts";
import { parseMime } from "../src/providers/mime.ts";
import { createSyncEngine, defaultSyncSettings, type SyncEngine } from "../src/providers/sync.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const SIDECAR_TOKEN = "per-launch-token";
const fixture = generateFixture();
const NOW = new Date(fixture.recordedAt);
const at = (hours: number, minutes = 0) =>
  new Date(NOW.getTime() + hours * 3_600_000 + minutes * 60_000).toISOString();

function accountFor(id: string, provider: Account["provider"], calendar: boolean): Account {
  return {
    id,
    provider,
    address: fixture.address,
    displayName: fixture.owner.name,
    capabilities: {
      push: true,
      labels: false,
      snooze: false,
      mute: false,
      calendar,
      meetingLink: calendar ? "meet" : null,
    },
  };
}

/** A Google-style invitation Message for the fixture owner, as another organizer would send it. */
function inviteMessage(uid: string, sequence: number, method: "REQUEST" | "CANCEL") {
  const ical = writeICalendar(
    {
      uid,
      sequence,
      stamp: NOW,
      title: "Podcast recording",
      description: "45 minutes on rebuilding old software categories.",
      location: "",
      start: new Date(at(48)),
      end: new Date(at(49)),
      allDay: false,
      zone: "Europe/Stockholm",
      organizer: { name: "Sofia Lindqvist", email: "sofia@lindqvist.test" },
      attendees: [
        {
          name: "Sofia Lindqvist",
          email: "sofia@lindqvist.test",
          response: "accepted",
          organizer: true,
        },
        { name: fixture.owner.name, email: fixture.address, response: "needs-action" },
      ],
      status: method === "CANCEL" ? "cancelled" : "confirmed",
      recurrence: null,
      link: "https://meet.jit.si/podcast-sofia",
    },
    method,
  );
  return {
    mailbox: "inbox" as const,
    threadKey: `podcast-${uid}`,
    from: { name: "Sofia Lindqvist", email: "sofia@lindqvist.test" },
    to: [fixture.owner],
    cc: [],
    subject: method === "CANCEL" ? "Cancelled: Podcast recording" : "Invitation: Podcast recording",
    date: NOW.toISOString(),
    messageId: `${uid}-${sequence}-${method}@lindqvist.test`,
    inReplyTo: null,
    references: [],
    seen: false,
    flagged: false,
    answered: false,
    headers: {},
    text: "You are invited.",
    html: null,
    attachments: [{ name: "invite.ics", mediaType: "text/calendar", text: ical }],
  };
}

interface World {
  db: TestDatabase;
  keys: Keys;
  store: Mailstore;
  jobs: Jobs;
  engine: SyncEngine;
  fake: FakeProvider;
  calendar: CalendarModule;
  app: Hono<AppEnv>;
  workspaceId: string;
  account: Account;
}

async function world(account: Account, fakeOptions: Parameters<typeof createFakeProvider>[1]) {
  const db = await testDatabase();
  const keys = createKeys(db.handle.db);
  await keys.unlock(randomKey());
  const store = createMailstore(db.handle.db, keys);
  const credentials = createCredentialStore(db.handle.db, store);
  const fake = createFakeProvider(fixture, fakeOptions);
  const workspaceId = (await store.createWorkspace(account)).id;
  await credentials.store(workspaceId, account.id, fakeCredentials(fixture.address));
  const jobs = createJobs(db.handle.db, { now: () => NOW });
  const engine = createSyncEngine({
    db: db.handle.db,
    mailstore: store,
    providers: createProviderRegistry({ overrides: { [account.provider]: fake } }),
    credentials,
    settings: async () => ({ ...defaultSyncSettings(), batchSize: 100 }),
    now: () => NOW,
    watchDebounceMs: 50,
  });
  const calendar = createCalendar({
    db: db.handle.db,
    mailstore: store,
    sync: engine,
    credentials,
    serverId: "server-a",
    now: () => NOW,
  });
  calendar.registerSteps(jobs);
  const intelligence = createIntelligence({
    db: db.handle.db,
    mailstore: store,
    chat: createFakeChat("ok").chat,
    converse: createFakeConverse().converse,
    integrations: createFakeIntegrations(),
    mcp: createFakeMcpClients(),
    now: () => NOW,
  });
  const app = createApp({
    db: db.handle.db,
    auth: createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN }),
    mode: "sidecar",
    keys,
    mailstore: store,
    jobs,
    sync: engine,
    intelligence,
    calendar,
    remoteAddress: () => "127.0.0.1",
  });
  const w: World = { db, keys, store, jobs, engine, fake, calendar, app, workspaceId, account };
  return w;
}

const request = (w: World, path: string, init: RequestInit = {}) =>
  w.app.request(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SIDECAR_TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
const send = (w: World, path: string, body: unknown, method = "POST") =>
  request(w, path, { method, body: JSON.stringify(body) });

const syncMail = async (w: World) => {
  let report = await w.engine.syncAccount(w.account.id);
  for (let i = 0; i < 20 && report.more; i++) report = await w.engine.syncAccount(w.account.id);
};

const changesOf = async (w: World, kind: Change["kind"]) =>
  (await w.store.listChanges(w.workspaceId, { since: 0, limit: 1000 })).changes.filter(
    (c) => c.kind === kind,
  );

describe("a Google-shaped Account: the Provider's calendar is synced and written, and Google mails the invitations", () => {
  let w: World;
  const account = accountFor("acct-google", "gmail", true);

  beforeAll(async () => {
    w = await world(account, { threads: true, calendar: { source: "google", now: () => NOW } });
    await syncMail(w);
  }, 60_000);
  afterAll(async () => {
    await w.calendar.close();
    await w.engine.close();
    await w.db.drop();
  });

  test("info reports the Provider's calendar with Meet and that the Provider sends invites", async () => {
    const info = await w.calendar.info(w.workspaceId);
    expect(info.source).toBe("google");
    expect(info.providerSendsInvites).toBe(true);
    expect(info.meetingLinks).toEqual(["google-meet"]);
    const res = await request(w, `/calendar/info?workspace=${w.workspaceId}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { source: string }).source).toBe("google");
  });

  test("a sync lists the calendars and pulls Events another client placed; the feed carries headers only", async () => {
    const google = w.fake.calendar;
    if (!google) throw new Error("no fake calendar");
    google.place({
      id: "",
      uid: "standup@google",
      title: "Standup",
      description: "",
      location: "",
      start: at(1),
      end: at(1, 30),
      allDay: false,
      timeZone: null,
      organizer: fixture.owner,
      attendees: [{ ...fixture.owner, response: "accepted", self: true, organizer: true }],
      link: null,
      status: "confirmed",
      recurrence: null,
      recurringEventId: null,
      response: "accepted",
    });
    const report = await w.calendar.syncAccount(account.id);
    expect(report.calendars).toBe(2);
    expect(report.upserted).toBe(1);

    const calendars = await w.calendar.listCalendars(w.workspaceId);
    expect(calendars.map((c) => [c.name, c.primary, c.writable])).toEqual([
      [fixture.address, true, true],
      ["Team (shared)", false, false],
    ]);

    const events = await w.calendar.listEvents(w.workspaceId, { from: at(0), to: at(24) });
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe("Standup");
    expect(events[0]?.response).toBe("accepted");

    const feed = await changesOf(w, "event");
    expect(feed).toHaveLength(1);
    const payload = feed[0]?.payload as Record<string, unknown>;
    expect(payload.start).toBe(at(1));
    expect("title" in payload).toBe(false);
    const calendarRows = await changesOf(w, "calendar");
    expect(calendarRows.length).toBeGreaterThanOrEqual(2);
  });

  test("createEvent makes one Event on Google with a Meet link; Google mails the invite and monday sends nothing", async () => {
    const google = w.fake.calendar;
    if (!google) throw new Error("no fake calendar");
    const before = w.fake.calls.send ?? 0;
    const event = await w.calendar.createEvent(
      w.workspaceId,
      {
        title: "Call with Aoife",
        start: at(72),
        end: at(72, 30),
        attendees: [{ name: "Aoife Brennan", email: "aoife@northwind.test" }],
        meetingLink: "google-meet",
      },
      { byAgent: true },
    );
    expect(event.link).toMatch(/^https:\/\/meet\.google\.com\//);
    expect(event.createdByAgent).toBe(true);
    expect(event.attendees.map((a) => a.email)).toEqual([fixture.address, "aoife@northwind.test"]);
    expect(google.snapshot().filter((e) => e.title === "Call with Aoife")).toHaveLength(1);
    // Google sent the invitation; monday's mail Session did not.
    expect(google.mailed).toEqual([
      { kind: "invite", eventId: event.providerId, to: ["aoife@northwind.test"] },
    ]);
    expect(w.fake.calls.send ?? 0).toBe(before);
    // A later sync sees the same Event, not a second one.
    await w.calendar.syncAccount(account.id);
    const events = await w.calendar.listEvents(w.workspaceId, { from: at(70), to: at(80) });
    expect(events).toHaveLength(1);
  });

  test("an invitation in a Message becomes an Invite linked to the Event Google placed; the RSVP goes through the API", async () => {
    const google = w.fake.calendar;
    if (!google) throw new Error("no fake calendar");
    // Google auto-adds the invitation to the calendar before the mail is read.
    google.place({
      id: "",
      uid: "podcast-1",
      title: "Podcast recording",
      description: "",
      location: "",
      start: at(48),
      end: at(49),
      allDay: false,
      timeZone: "Europe/Stockholm",
      organizer: { name: "Sofia Lindqvist", email: "sofia@lindqvist.test" },
      attendees: [
        {
          name: "Sofia Lindqvist",
          email: "sofia@lindqvist.test",
          response: "accepted",
          organizer: true,
        },
        { ...fixture.owner, response: "needs-action", self: true },
      ],
      link: "https://meet.jit.si/podcast-sofia",
      status: "confirmed",
      recurrence: null,
      recurringEventId: null,
      response: "needs-action",
    });
    await w.calendar.syncAccount(account.id);
    const id = w.fake.deliver(inviteMessage("podcast-1", 0, "REQUEST"));
    await syncMail(w);
    const message = await w.db.handle.db.query.messages.findFirst({
      where: (t, { eq }) => eq(t.providerMessageId, id),
    });
    if (!message) throw new Error("message not stored");
    const invites = await w.calendar.invitesOfThread(message.threadId);
    expect(invites).toHaveLength(1);
    const invite = invites[0] as Invite;
    expect(invite.title).toBe("Podcast recording");
    expect(invite.method).toBe("REQUEST");
    expect(invite.byMail).toBe(false);
    expect(invite.senderMismatch).toBe(false);
    expect(invite.eventId).not.toBeNull();
    expect(invite.response).toBe("needs-action");

    const res = await send(w, `/invites/${invite.id}/rsvp`, {
      at: NOW.toISOString(),
      actor: "user",
      response: "accepted",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true });
    const mailedReply = google.mailed.find((m) => m.kind === "reply");
    expect(mailedReply).toEqual({
      kind: "reply",
      eventId: expect.any(String),
      to: ["sofia@lindqvist.test"],
      response: "accepted",
    });
    const event = await w.calendar.readEvent(invite.eventId as string);
    expect(event?.response).toBe("accepted");
    const again = (await w.calendar.invitesOfThread(message.threadId))[0];
    expect(again?.response).toBe("accepted");
    // Nothing went out over the mail Session.
    expect(w.fake.calls.send ?? 0).toBe(0);
  });

  test("an older RSVP intent loses last-writer-wins on the Invite", async () => {
    const [invite] = (
      await w.db.handle.db.query.invites.findMany({
        where: (t, { eq }) => eq(t.workspaceId, w.workspaceId),
      })
    ).map((r) => r.id);
    const res = await send(w, `/invites/${invite}/rsvp`, {
      at: new Date(NOW.getTime() - 60_000).toISOString(),
      actor: "automation",
      response: "declined",
    });
    expect(((await res.json()) as { applied: boolean }).applied).toBe(false);
  });

  test("the routes: a window read, an update, a response and a delete", async () => {
    const list = await request(
      w,
      `/calendar/events?workspace=${w.workspaceId}&from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(100))}`,
    );
    expect(list.status).toBe(200);
    const { events } = (await list.json()) as { events: CalendarEvent[] };
    const call = events.find((e) => e.title === "Call with Aoife");
    if (!call) throw new Error("no call");
    const updated = await send(
      w,
      `/calendar/events/${call.id}`,
      { title: "Call with Aoife (moved)", start: at(73), end: at(73, 30) },
      "PUT",
    );
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as CalendarEvent).title).toBe("Call with Aoife (moved)");
    const content = await send(w, "/calendar/events/content", {
      workspace: w.workspaceId,
      ids: [call.id],
    });
    expect(((await content.json()) as { events: { title: string }[] }).events[0]?.title).toBe(
      "Call with Aoife (moved)",
    );
    const removed = await request(w, `/calendar/events/${call.id}`, { method: "DELETE" });
    expect(removed.status).toBe(204);
    expect(await w.calendar.readEvent(call.id)).toBeNull();
    const cancel = w.fake.calendar?.mailed.find((m) => m.kind === "cancel");
    expect(cancel?.to).toEqual(["aoife@northwind.test"]);
    const hidden = await send(
      w,
      `/calendars/${events[0]?.calendarId}/visible`,
      { visible: false },
      "PUT",
    );
    expect(((await hidden.json()) as { visible: boolean }).visible).toBe(false);
  });
});

describe("an IMAP-only Account: the Local calendar, iMIP mailed by monday, an invitation answered by reply mail", () => {
  let w: World;
  const account = accountFor("acct-imap", "imap", false);

  beforeAll(async () => {
    w = await world(account, {});
    await syncMail(w);
  }, 60_000);
  afterAll(async () => {
    await w.calendar.close();
    await w.engine.close();
    await w.db.drop();
  });

  test("info reports the Local calendar and that monday mails invitations", async () => {
    const info = await w.calendar.info(w.workspaceId);
    expect(info.source).toBe("local");
    expect(info.providerSendsInvites).toBe(false);
    const calendars = await w.calendar.listCalendars(w.workspaceId);
    expect(calendars).toHaveLength(1);
    expect(calendars[0]?.source).toBe("local");
  });

  test("createEvent with attendees stores the Event and mails one iMIP REQUEST over the Account's own Session", async () => {
    const event = await w.calendar.createEvent(w.workspaceId, {
      title: "Term sheet call",
      start: at(24),
      end: at(25),
      attendees: [{ name: "Kenji Watanabe", email: "kenji.w@meridianfund.co" }],
      meetingLink: "jitsi",
    });
    expect(event.link).toMatch(/^https:\/\/meet\.jit\.si\/monday-/);
    expect(w.fake.calls.send).toBe(1);
    const sent = w.fake.snapshot().find((m) => m.id.startsWith("s"));
    if (!sent) throw new Error("nothing in Sent");
    const raw = await w.fake.connect(fakeCredentials()).then((s) => s.fetchMessage(sent.id));
    const part = raw.attachments.find((a) => a.mediaType.startsWith("text/calendar"));
    if (!part) throw new Error("no text/calendar part");
    const chunks: Uint8Array[] = [];
    for await (const c of part.content()) chunks.push(c);
    const parsed = parseICalendar(new TextDecoder().decode(chunks[0]));
    expect(parsed.method).toBe("REQUEST");
    expect(parsed.events[0]?.title).toBe("Term sheet call");
    expect(parsed.events[0]?.attendees.map((a) => a.email)).toEqual([
      fixture.address,
      "kenji.w@meridianfund.co",
    ]);
    expect(raw.headers.to).toContain("kenji.w@meridianfund.co");
  });

  test("an invitation in a Message lands on the Local calendar as an Invite and an Event; accepting mails a REPLY", async () => {
    const sendsBefore = w.fake.calls.send ?? 0;
    const id = w.fake.deliver(inviteMessage("podcast-2", 0, "REQUEST"));
    await syncMail(w);
    const message = await w.db.handle.db.query.messages.findFirst({
      where: (t, { eq }) => eq(t.providerMessageId, id),
    });
    if (!message) throw new Error("message not stored");
    const [invite] = await w.calendar.invitesOfThread(message.threadId);
    if (!invite) throw new Error("no invite");
    expect(invite.byMail).toBe(true);
    expect(invite.eventId).not.toBeNull();
    const event = await w.calendar.readEvent(invite.eventId as string);
    expect(event?.title).toBe("Podcast recording");
    expect(event?.response).toBe("needs-action");
    expect(event?.timeZone).toBe("Europe/Stockholm");
    expect(event?.link).toBe("https://meet.jit.si/podcast-sofia");

    const busy = await w.calendar.busy(w.workspaceId, at(47), at(50));
    expect(busy.map((b) => b.title)).toEqual(["Podcast recording"]);

    await w.calendar.applyInviteIntent({
      kind: "invite.rsvp",
      inviteId: invite.id,
      response: "accepted",
      at: NOW.toISOString(),
      actor: "user",
    });
    expect(w.fake.calls.send).toBe(sendsBefore + 1);
    const after = await w.calendar.readEvent(invite.eventId as string);
    expect(after?.response).toBe("accepted");
    const sent = w.fake
      .snapshot()
      .filter((m) => m.id.startsWith("s"))
      .at(-1);
    if (!sent) throw new Error("nothing in Sent");
    const raw = await w.fake.connect(fakeCredentials()).then((s) => s.fetchMessage(sent.id));
    expect(raw.headers.to).toContain("sofia@lindqvist.test");
    const part = raw.attachments.find((a) => a.mediaType.startsWith("text/calendar"));
    if (!part) throw new Error("no text/calendar part");
    const chunks: Uint8Array[] = [];
    for await (const c of part.content()) chunks.push(c);
    const parsed = parseICalendar(new TextDecoder().decode(chunks[0]));
    expect(parsed.method).toBe("REPLY");
    expect(parsed.events[0]?.attendees).toHaveLength(1);
    expect(parsed.events[0]?.attendees[0]?.response).toBe("accepted");
    expect(parsed.events[0]?.uid).toBe("podcast-2");
  });

  test("a REQUEST with a higher SEQUENCE asks again; a CANCEL marks the Event cancelled", async () => {
    const id = w.fake.deliver(inviteMessage("podcast-2", 1, "REQUEST"));
    await syncMail(w);
    const message = await w.db.handle.db.query.messages.findFirst({
      where: (t, { eq }) => eq(t.providerMessageId, id),
    });
    if (!message) throw new Error("message not stored");
    const [invite] = await w.calendar.invitesOfThread(message.threadId);
    expect(invite?.sequence).toBe(1);
    expect(invite?.response).toBe("needs-action");

    const cancelId = w.fake.deliver(inviteMessage("podcast-2", 1, "CANCEL"));
    await syncMail(w);
    const cancelled = await w.db.handle.db.query.messages.findFirst({
      where: (t, { eq }) => eq(t.providerMessageId, cancelId),
    });
    if (!cancelled) throw new Error("message not stored");
    const [cancelInvite] = await w.calendar.invitesOfThread(cancelled.threadId);
    expect(cancelInvite?.method).toBe("CANCEL");
    const event = await w.calendar.readEvent(invite?.eventId as string);
    expect(event?.status).toBe("cancelled");
  });

  test("a REQUEST whose From does not match the ORGANIZER is shown with a warning and never placed", async () => {
    const forged = {
      ...inviteMessage("forged-1", 0, "REQUEST"),
      from: { name: "Someone", email: "someone@else.test" },
    };
    const id = w.fake.deliver(forged);
    await syncMail(w);
    const message = await w.db.handle.db.query.messages.findFirst({
      where: (t, { eq }) => eq(t.providerMessageId, id),
    });
    if (!message) throw new Error("message not stored");
    const [invite] = await w.calendar.invitesOfThread(message.threadId);
    expect(invite?.senderMismatch).toBe(true);
    expect(invite?.eventId).toBeNull();
  });

  test("a mime round trip of the REQUEST parses back with postal-mime as a text/calendar part with its method", async () => {
    const ical = writeICalendar(
      {
        uid: "rt-1",
        sequence: 0,
        stamp: NOW,
        title: "Round trip",
        description: "",
        location: "",
        start: new Date(at(1)),
        end: new Date(at(2)),
        allDay: false,
        zone: null,
        organizer: fixture.owner,
        attendees: [],
        status: "confirmed",
        recurrence: null,
        link: null,
      },
      "REQUEST",
    );
    const { composeMime } = await import("../src/providers/mime.ts");
    const mime = await composeMime({
      from: fixture.owner,
      to: [{ name: "A", email: "a@b.test" }],
      subject: "x",
      text: "y",
      icalEvent: { method: "REQUEST", content: ical },
    });
    const parsed = await parseMime(mime);
    const part = parsed.attachments.find((a) => a.mimeType === "text/calendar");
    expect(part).toBeDefined();
    expect((part as { method?: string }).method).toBe("REQUEST");
  });
});
