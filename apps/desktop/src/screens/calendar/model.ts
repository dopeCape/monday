// Questions the views ask of an Event: is it the user's to change, who are
// its guests, how it reads (tentative, declined, made by the Agent), and
// an error as the plain words a Server or Provider gave. Pure.

import type { Calendar, CalendarEvent, Person } from "@monday/shared";

/** The address the Event's Account signs in with, when the source knows it. */
export type AddressOf = (workspaceId: string) => string | null;

function lower(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

/** The user organizes it: no organizer, the own attendee marked organizer, or the Account's own address. */
export function isOwn(e: CalendarEvent, addressOf: AddressOf): boolean {
  if (!e.organizer) return true;
  if (e.attendees.some((a) => a.self && a.organizer)) return true;
  const me = lower(addressOf(e.workspaceId));
  if (me && lower(e.organizer.email) === me) return true;
  // A Provider that marks the own attendee but not the organizer: an Event nobody else attends is own.
  return e.attendees.length > 0 && e.attendees.every((a) => a.self);
}

/** The people other than the user on an Event. */
export function guestsOf(
  e: Pick<CalendarEvent, "attendees" | "workspaceId">,
  addressOf: AddressOf,
): Person[] {
  const me = lower(addressOf(e.workspaceId));
  return e.attendees
    .filter((a) => !a.self && !(me && lower(a.email) === me))
    .map((a) => ({ name: a.name, email: a.email }));
}

/** The user can move, resize, edit and delete it for everyone. */
export function canEdit(
  e: CalendarEvent,
  calendars: ReadonlyMap<string, Calendar>,
  addressOf: AddressOf,
): boolean {
  const cal = calendars.get(e.calendarId);
  return Boolean(cal?.writable) && isOwn(e, addressOf);
}

/** The user was invited and may answer. */
export function canAnswer(e: CalendarEvent, addressOf: AddressOf): boolean {
  if (isOwn(e, addressOf)) return false;
  if (e.response !== null) return true;
  const me = lower(addressOf(e.workspaceId));
  return e.attendees.some((a) => a.self || (me !== "" && lower(a.email) === me));
}

/** The modifier classes an Event block carries. */
export function toneOf(e: CalendarEvent, now: Date): string {
  const out: string[] = [];
  if (e.createdByAgent) out.push("agent");
  if (e.response === "declined") out.push("declined");
  else if (e.response === "needs-action" || e.response === "tentative" || e.status === "tentative")
    out.push("tentative");
  if (Date.parse(e.end) <= now.getTime()) out.push("past");
  return out.join(" ");
}

/** "Aoife Brennan, Kenji" for a block's second line. */
export function whoOf(e: CalendarEvent, addressOf: AddressOf): string {
  return guestsOf(e, addressOf)
    .map((p) => p.name || p.email)
    .join(", ");
}

export function linkHost(link: string): string {
  try {
    return new URL(link).host;
  } catch {
    return link;
  }
}

/**
 * An error as words: the `message` of a JSON body the Server answered with,
 * else the error's own message.
 */
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const body = JSON.parse(raw) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string" && body.message) return body.message;
    if (typeof body.error === "string") return body.error;
  } catch {
    // Not JSON.
  }
  return raw;
}

/** "Jane Doe <jane@x.io>, bob@y.io" into people; blanks dropped, duplicates once. */
export function parsePeople(text: string): Person[] {
  const seen = new Set<string>();
  const out: Person[] = [];
  for (const part of text.split(/[,;\n]/)) {
    const p = part.trim();
    if (!p) continue;
    const m = /^\s*"?(.*?)"?\s*<([^>]+)>\s*$/.exec(p);
    const person = m ? { name: m[1] ?? "", email: (m[2] ?? "").trim() } : { name: "", email: p };
    const key = person.email.toLowerCase();
    if (!person.email.includes("@") || seen.has(key)) continue;
    seen.add(key);
    out.push(person);
  }
  return out;
}
