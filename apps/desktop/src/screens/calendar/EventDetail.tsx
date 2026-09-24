// An Event's detail, in the popover beside it: the title in its calendar's
// colour, when (with the Event's own zone when it differs from the
// Device's), how it repeats, the calendar and Account, the place, the
// meeting link with Join, the organizer and the guests with their answers,
// the notes, the user's own answer (Yes, Maybe, No) on an invite, and edit,
// duplicate and delete for the user's own.

import type { Calendar, RsvpResponse, Settings } from "@monday/shared";
import { Btn, formatSpan, Icon } from "@monday/ui";
import {
  ArrowsClockwiseIcon,
  BellIcon,
  CheckCircleIcon,
  CopyIcon,
  GlobeIcon,
  MapPinIcon,
  PencilSimpleIcon,
  QuestionIcon,
  TextAlignLeftIcon,
  TrashIcon,
  UsersIcon,
  VideoCameraIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import type { Occurrence } from "./calendar-data.ts";
import { clockIn, deviceZone, offsetIn } from "./dates.ts";
import { linkHost } from "./model.ts";
import { describeRule } from "./repeat.ts";

export interface EventDetailProps {
  occ: Occurrence;
  calendar: Calendar | undefined;
  account: string | null;
  color: string;
  s: Settings;
  now: Date;
  editable: boolean;
  answerable: boolean;
  onClose: () => void;
  onJoin: (link: string) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onRespond: (response: "accepted" | "tentative" | "declined") => void;
}

const fill = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

function answerIcon(r: RsvpResponse) {
  if (r === "accepted") return CheckCircleIcon;
  if (r === "declined") return XCircleIcon;
  return QuestionIcon;
}

function reminderWords(minutes: number, s: Settings): string {
  if (minutes === 0) return s["strings.calendar.reminder.at_start"];
  if (minutes % 1440 === 0) return fill(s["strings.calendar.reminder.days"], { n: minutes / 1440 });
  if (minutes % 60 === 0) return fill(s["strings.calendar.reminder.hours"], { n: minutes / 60 });
  return fill(s["strings.calendar.reminder.minutes"], { n: minutes });
}

export { reminderWords };

export function EventDetail({
  occ: o,
  calendar,
  account,
  color,
  s,
  now,
  editable,
  answerable,
  onClose,
  onJoin,
  onEdit,
  onDuplicate,
  onDelete,
  onRespond,
}: EventDetailProps) {
  const here = deviceZone();
  const start = new Date(o.start);
  const zoned =
    !o.allDay &&
    o.timeZone &&
    o.timeZone !== here &&
    offsetIn(o.timeZone, start) !== offsetIn(here, start)
      ? fill(s["strings.calendar.detail.in_zone"], {
          from: clockIn(o.timeZone, start) ?? "",
          to: clockIn(o.timeZone, new Date(o.end)) ?? "",
          zone: o.timeZone,
        })
      : null;
  const people = o.attendees.filter((a) => !a.organizer || a.self);
  const counts = {
    yes: o.attendees.filter((a) => a.response === "accepted").length,
    no: o.attendees.filter((a) => a.response === "declined").length,
    maybe: o.attendees.filter((a) => a.response === "tentative").length,
    waiting: o.attendees.filter((a) => a.response === "needs-action").length,
  };
  const live = o.link && Date.parse(o.end) > now.getTime();
  const soon =
    o.link &&
    Date.parse(o.start) - now.getTime() <= s["notifications.calendar_lead_minutes"] * 60_000 &&
    live;
  return (
    <div className="cal-detail" style={{ "--ev": color } as CSSProperties}>
      <div className="cal-detail-tools">
        {editable ? (
          <Btn icon sm title={s["strings.calendar.edit"]} onClick={onEdit}>
            <Icon icon={PencilSimpleIcon} />
          </Btn>
        ) : null}
        <Btn icon sm title={s["strings.calendar.duplicate"]} onClick={onDuplicate}>
          <Icon icon={CopyIcon} />
        </Btn>
        {calendar?.writable ? (
          <Btn icon sm title={s["strings.calendar.delete"]} onClick={onDelete}>
            <Icon icon={TrashIcon} />
          </Btn>
        ) : null}
        <Btn icon sm title={s["strings.calendar.close"]} onClick={onClose}>
          <Icon icon={XIcon} />
        </Btn>
      </div>
      <div className="cal-detail-title">
        <span className="cal-dot" aria-hidden="true" />
        <h3>{o.title || s["strings.calendar.untitled"]}</h3>
      </div>
      <p className="cal-detail-when">
        {formatSpan(o.start, o.end, o.allDay)}
        {zoned ? <span>{zoned}</span> : null}
      </p>
      {o.recurrence || o.recurringEventId ? (
        <p className="cal-detail-line">
          <Icon icon={ArrowsClockwiseIcon} />
          {o.recurrence ? describeRule(o.recurrence, s) : s["strings.calendar.detail.repeats"]}
        </p>
      ) : null}
      {o.link ? (
        <div className="cal-detail-line cal-detail-link">
          <Icon icon={VideoCameraIcon} />
          <span>{linkHost(o.link)}</span>
          {live ? (
            <Btn sm primary={Boolean(soon)} onClick={() => onJoin(o.link as string)}>
              {s["strings.calendar.join"]}
            </Btn>
          ) : null}
        </div>
      ) : null}
      {o.location && o.location !== o.link ? (
        <p className="cal-detail-line">
          <Icon icon={MapPinIcon} />
          {o.location}
        </p>
      ) : null}
      {o.organizer || people.length ? (
        <div className="cal-detail-people">
          <p className="cal-detail-line">
            <Icon icon={UsersIcon} />
            {fill(s["strings.calendar.detail.guests"], { n: o.attendees.length || 1 })}
            <span className="faint">
              {[
                counts.yes ? fill(s["strings.calendar.detail.yes_count"], { n: counts.yes }) : "",
                counts.maybe
                  ? fill(s["strings.calendar.detail.maybe_count"], { n: counts.maybe })
                  : "",
                counts.no ? fill(s["strings.calendar.detail.no_count"], { n: counts.no }) : "",
                counts.waiting
                  ? fill(s["strings.calendar.detail.waiting_count"], { n: counts.waiting })
                  : "",
              ]
                .filter(Boolean)
                .join(", ")}
            </span>
          </p>
          <ul>
            {o.organizer ? (
              <li>
                <Icon icon={CheckCircleIcon} className="yes" />
                <span>{o.organizer.name || o.organizer.email}</span>
                <i>{s["strings.calendar.detail.organizer"]}</i>
              </li>
            ) : null}
            {people
              .filter((a) => a.email.toLowerCase() !== o.organizer?.email.toLowerCase())
              .map((a) => (
                <li key={a.email} title={a.email}>
                  <Icon
                    icon={answerIcon(a.response)}
                    className={
                      a.response === "accepted" ? "yes" : a.response === "declined" ? "no" : "maybe"
                    }
                  />
                  <span>
                    {a.name || a.email}
                    {a.self ? ` ${s["strings.calendar.detail.you"]}` : ""}
                  </span>
                  {a.optional ? <i>{s["strings.calendar.detail.optional"]}</i> : null}
                </li>
              ))}
          </ul>
        </div>
      ) : null}
      {o.reminders && o.reminders.length > 0 ? (
        <p className="cal-detail-line">
          <Icon icon={BellIcon} />
          {o.reminders.map((m) => reminderWords(m, s)).join(", ")}
        </p>
      ) : null}
      {o.description ? (
        <div className="cal-detail-line cal-detail-notes">
          <Icon icon={TextAlignLeftIcon} />
          <p>{o.description}</p>
        </div>
      ) : null}
      <p className="cal-detail-line cal-detail-cal">
        <span className="cal-dot" aria-hidden="true" />
        {calendar?.name ?? ""}
        {account && account !== calendar?.name ? <span className="faint"> · {account}</span> : null}
        {o.createdByAgent ? (
          <span className="faint"> · {s["strings.calendar.by_agent"]}</span>
        ) : null}
      </p>
      {o.timeZone && o.timeZone !== here && !zoned ? (
        <p className="cal-detail-line faint">
          <Icon icon={GlobeIcon} />
          {o.timeZone}
        </p>
      ) : null}
      {answerable ? (
        <div className="cal-rsvp">
          <span>{s["strings.calendar.rsvp.going"]}</span>
          {(
            [
              ["accepted", s["strings.calendar.rsvp.yes"]],
              ["tentative", s["strings.calendar.rsvp.maybe"]],
              ["declined", s["strings.calendar.rsvp.no"]],
            ] as const
          ).map(([value, label]) => (
            <Btn
              sm
              outline={o.response !== value}
              key={value}
              on={o.response === value}
              aria-pressed={o.response === value}
              onClick={() => onRespond(value)}
            >
              {label}
            </Btn>
          ))}
        </div>
      ) : null}
    </div>
  );
}
