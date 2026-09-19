// Event reminders (slice 18): a desktop notification a Setting's number of
// minutes before an Event the user has not declined. Runs on the Device from
// the Cache, so a reminder never needs the Server awake; one timer for the
// next Event, re-armed whenever the Events or the Settings change. The
// notification goes through the web Notification API where the webview
// offers it; permission is asked the first time a reminder is due.

import type { Settings } from "@monday/shared";
import { useEffect } from "react";
import type { CalendarSource } from "../screens/calendar/calendar-data.ts";
import { occurrencesIn } from "../screens/calendar/calendar-data.ts";

export interface Reminder {
  key: string;
  title: string;
  body: string;
  at: Date;
}

/** The next reminder due after `now`, or null: the earliest Event start minus the lead, not yet fired. */
export function nextReminder(
  source: Pick<CalendarSource, "events" | "calendars">,
  leadMinutes: number,
  now: Date,
  fired: ReadonlySet<string>,
  body: (title: string, time: string) => string,
): Reminder | null {
  const window = { from: now, to: new Date(now.getTime() + 2 * 86_400_000) };
  const items = occurrencesIn(source.events(), source.calendars(), window);
  for (const o of items) {
    if (o.allDay || o.response === "declined") continue;
    const at = new Date(Date.parse(o.start) - leadMinutes * 60_000);
    if (at.getTime() < now.getTime() - 60_000) continue;
    if (fired.has(o.key)) continue;
    const time = new Date(o.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return { key: o.key, title: o.title, body: body(o.title, time), at };
  }
  return null;
}

export interface Notifier {
  notify(title: string, body: string): Promise<void>;
}

/** The web Notification API, asking once; silent where the webview has none. */
export const webNotifier: Notifier = {
  async notify(title, body) {
    if (typeof Notification === "undefined") return;
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    if (permission !== "granted") return;
    new Notification(title, { body });
  },
};

/** Arms the next reminder and fires it; re-arms on every change. Returns the stop function. */
export function scheduleReminders(
  source: CalendarSource,
  settings: () => Pick<
    Settings,
    "notifications.enabled" | "notifications.calendar_lead_minutes" | "strings.calendar.reminder"
  >,
  notifier: Notifier = webNotifier,
  now: () => Date = () => new Date(),
): () => void {
  const fired = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const s = settings();
    if (!s["notifications.enabled"]) return;
    const body = (title: string, time: string) =>
      s["strings.calendar.reminder"].replace("{title}", title).replace("{time}", time);
    const next = nextReminder(source, s["notifications.calendar_lead_minutes"], now(), fired, body);
    if (!next) return;
    const delay = Math.max(0, next.at.getTime() - now().getTime());
    timer = setTimeout(
      () => {
        fired.add(next.key);
        void notifier.notify(next.title, next.body).catch(() => {});
        arm();
      },
      Math.min(delay, 2_147_000_000),
    );
  };
  const unsubscribe = source.subscribe(arm);
  arm();
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}

export function useEventReminders(source: CalendarSource | undefined, settings: Settings): void {
  const enabled = settings["notifications.enabled"];
  const lead = settings["notifications.calendar_lead_minutes"];
  const text = settings["strings.calendar.reminder"];
  useEffect(() => {
    if (!source) return;
    return scheduleReminders(source, () => ({
      "notifications.enabled": enabled,
      "notifications.calendar_lead_minutes": lead,
      "strings.calendar.reminder": text,
    }));
  }, [source, enabled, lead, text]);
}
