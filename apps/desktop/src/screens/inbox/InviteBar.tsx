// The invite bar (CONTEXT.md "Invite"; design/js/screens/calendar.js
// "Invite in a thread"): the text/calendar part of a Thread as one bar under
// the Brief: the title, the slot, the organizer, an overlap with the user's
// own calendar, and Accept, Tentative, Decline. The answer is an Outbox
// intent, so it lands at once and replays; on a mail-only Account the bar
// says the reply goes by mail. A sender that is not the organizer gets a
// warning and no buttons (RFC 6047 2.3). A CANCEL shows as cancelled.

import type { Invite, RsvpResponse, Settings } from "@monday/shared";
import { Btn, formatSpan, Icon, Tag } from "@monday/ui";
import { CalendarBlankIcon, WarningIcon } from "@phosphor-icons/react";
import { useMemo, useSyncExternalStore } from "react";
import { openExternal } from "../../platform/open.ts";
import { answerLabel, TodayPanel } from "../Calendar.tsx";
import { type CalendarSource, type Occurrence, occurrencesIn } from "../calendar/calendar-data.ts";
import { fill } from "./triage.ts";

export interface InviteBarProps {
  invites: readonly Invite[];
  /** The user's own Events overlapping the invite's slot, the invite's own Event left out. */
  overlaps: readonly Occurrence[];
  strings: Settings;
  onRsvp: (inviteId: string, response: RsvpResponse) => void;
}

/** The newest REQUEST in a Thread rules, unless a CANCEL came after it. */
export function currentInvite(invites: readonly Invite[]): Invite | null {
  const sorted = [...invites].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const last = sorted.at(-1);
  if (!last) return null;
  if (last.method === "CANCEL") return last;
  return sorted.filter((i) => i.method === "REQUEST").at(-1) ?? null;
}

export function InviteBar({ invites, overlaps, strings: s, onRsvp }: InviteBarProps) {
  const invite = currentInvite(invites);
  if (!invite) return null;
  const cancelled = invite.method === "CANCEL";
  const updated = !cancelled && invites.filter((i) => i.method === "REQUEST").length > 1;
  const organizer = invite.organizer?.name || invite.organizer?.email || "";
  const answered = invite.response !== "needs-action";
  const overlap = overlaps.find((o) => o.id !== invite.eventId);
  return (
    <div className="invite" data-invite={invite.id}>
      <div className="inv-h">
        <Icon icon={CalendarBlankIcon} />
        {invite.title}
        {cancelled ? (
          <Tag>{s["strings.calendar.cancelled"]}</Tag>
        ) : updated && !answered ? (
          <Tag>{s["strings.calendar.updated"]}</Tag>
        ) : (
          <Tag>{answerLabel(s, invite.response)}</Tag>
        )}
      </div>
      <div className="inv-d">
        {formatSpan(invite.start, invite.end, invite.allDay)}
        {organizer ? ` · ${organizer}` : ""}
      </div>
      {invite.senderMismatch ? (
        <div className="inv-c">
          <Icon icon={WarningIcon} />
          {fill(s["strings.calendar.sender_mismatch"], { from: organizer })}
        </div>
      ) : overlap && !cancelled ? (
        <div className="inv-c">
          <Icon icon={WarningIcon} />
          {fill(s["strings.calendar.overlaps"], {
            title: overlap.title,
            when: formatSpan(overlap.start, overlap.end, overlap.allDay),
          })}
        </div>
      ) : null}
      {!cancelled && !invite.senderMismatch ? (
        <div className="inv-a">
          <Btn
            sm
            primary={invite.response !== "accepted"}
            on={invite.response === "accepted"}
            onClick={() => onRsvp(invite.id, "accepted")}
          >
            {s["strings.calendar.accept"]}
          </Btn>
          <Btn
            sm
            on={invite.response === "tentative"}
            onClick={() => onRsvp(invite.id, "tentative")}
          >
            {s["strings.calendar.tentative"]}
          </Btn>
          <Btn sm on={invite.response === "declined"} onClick={() => onRsvp(invite.id, "declined")}>
            {s["strings.calendar.decline"]}
          </Btn>
          {invite.byMail && organizer ? (
            <span className="answered">{fill(s["strings.calendar.by_mail"], { organizer })}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface ThreadInviteBarProps {
  calendar: CalendarSource;
  threadId: string;
  settings: Settings;
}

/** The invite bar over the calendar seam: the Thread's Invites and the user's own overlapping Events. */
export function ThreadInviteBar({ calendar, threadId, settings }: ThreadInviteBarProps) {
  const invites = useSyncExternalStore(
    calendar.subscribe,
    () => calendar.invitesOf(threadId),
    () => calendar.invitesOf(threadId),
  );
  const events = useSyncExternalStore(calendar.subscribe, calendar.events, calendar.events);
  const calendars = useSyncExternalStore(
    calendar.subscribe,
    calendar.calendars,
    calendar.calendars,
  );
  const invite = currentInvite(invites);
  const overlaps = useMemo(
    () =>
      invite
        ? occurrencesIn(events, calendars, {
            from: new Date(invite.start),
            to: new Date(invite.end),
          })
        : [],
    [invite, events, calendars],
  );
  if (!invite) return null;
  return (
    <InviteBar
      invites={invites}
      overlaps={overlaps}
      strings={settings}
      onRsvp={(id, response) => void calendar.rsvp(id, response)}
    />
  );
}

export interface StreamTodayPanelProps {
  calendar: CalendarSource;
  now: Date;
  settings: Settings;
}

/** The Today panel at the top of the inbox stream (Setting calendar.today_panel): today's Events, or nothing. */
export function StreamTodayPanel({ calendar, now, settings }: StreamTodayPanelProps) {
  const events = useSyncExternalStore(calendar.subscribe, calendar.events, calendar.events);
  const calendars = useSyncExternalStore(
    calendar.subscribe,
    calendar.calendars,
    calendar.calendars,
  );
  const items = useMemo(() => {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const to = new Date(from.getTime() + 86_400_000);
    return occurrencesIn(events, calendars, { from, to });
  }, [events, calendars, now]);
  if (items.length === 0) return null;
  return (
    <div className="stream-today" data-today-panel>
      <div className="sec">{settings["strings.calendar.today_panel"]}</div>
      <TodayPanel
        items={items}
        now={now}
        strings={settings}
        onJoin={(o) => void openExternal(o.link as string)}
      />
    </div>
  );
}
