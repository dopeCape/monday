// Actions on a View's items (docs/spec/views.md, "Actions on items"): a
// button a View's document declares, run on the Device over the same paths
// as the Custom actions and the Recommended actions, never a second one.
// Archive, mark read, snooze, move and tag apply through InboxActions with
// Undo; a reply from a Template and a forward open compose and send nothing
// (ADR 0002); a Workflow starts through the Workflow runner, each Step
// keeping its own approval; a link opens only after its domain is shown; a
// Custom action runs with its own Tier; set_lane and mark_done are the
// View's own corrections; ask_agent opens the Agent with the Threads named.
// A group action (a Lane's or group's header) runs once per Thread whose
// `when` holds. Pure over a host seam, so every kind is testable.

import type { ActionDo, Person, ValueWords, ViewAction, ViewThread } from "@monday/shared";
import {
  actionShows,
  formatFieldValue,
  readField,
  type ViewBase,
  type ViewRow,
} from "@monday/shared";
import type { UndoToken } from "../screens/inbox/actions.ts";

/** What an action acts through: the Inbox's actions, compose, the Workflow runner, the View's own writes. */
export interface ViewActionHost {
  archive(ids: readonly string[]): Promise<UndoToken | null>;
  markRead(ids: readonly string[], read: boolean): Promise<UndoToken | null>;
  snooze(ids: readonly string[], until: Date): Promise<UndoToken | null>;
  move(ids: readonly string[], groupId: string): Promise<UndoToken | null>;
  /** Adds a Tag by name; null when the Device cannot (the Agent's Server host can). */
  tag(ids: readonly string[], tag: string): Promise<UndoToken | null | "unavailable">;
  /** Opens compose on the Thread; the user still sends. */
  compose(
    kind: "reply" | "forward",
    threadId: string,
    seed: { to?: Person[] | undefined; templateId?: string | undefined },
  ): void;
  /** Starts a Workflow on the Thread with its inputs; each Step keeps its own approval. */
  runWorkflow(workflowId: string, threadId: string, inputs: Record<string, string>): Promise<void>;
  /** Runs one of the user's Custom actions with its Tier; false when the Device cannot. */
  customAction(actionId: string, threadId: string): Promise<boolean>;
  /** Asks before a link opens: its domain in words. Resolves false when the user says no. */
  confirm(text: string): Promise<boolean>;
  openLink(url: string): void | Promise<void>;
  /** The owner's own Event, through the calendar's card; absent without a calendar. */
  createEvent?:
    | ((event: { title: string; start: string; end: string }) => Promise<void>)
    | undefined;
  setLane(threadId: string, lane: string): Promise<void>;
  markDone(threadId: string, messageCount: number): Promise<void>;
  /** Opens the Agent with a sentence ready; nothing runs until the user sends it. */
  ask(text: string): void;
}

/** The part of the host the Inbox gives a View: its own actions, compose, the runners, a toast with Undo. */
export type InboxViewHost = Omit<ViewActionHost, "confirm" | "setLane" | "markDone" | "ask"> & {
  toast(text: string, undo: UndoToken | null): void;
};

export type ViewActionResult =
  | { ok: true; undo: UndoToken[]; ran: number }
  | { ok: false; reason: "unavailable" | "no_value" | "cancelled" | "nothing" };

export interface ViewActionOptions {
  /** The hour a snooze preset wakes at (inbox.snooze.morning_hour). */
  morningHour: number;
  /** "Open {domain}?" */
  opensWords: string;
  /** "{prompt} (threads: {threads})" */
  askWords: string;
  /** The length of an Event added from a date (actions.calendar.default_minutes). */
  eventMinutes: number;
  words?: ValueWords | undefined;
}

const fill = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

/** A snooze preset as a moment: tomorrow, next Monday or Saturday, at the morning hour. */
export function presetMoment(
  preset: "tomorrow" | "next_week" | "weekend",
  now: Date,
  morningHour: number,
): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), morningHour);
  const weekday = d.getDay();
  if (preset === "tomorrow") d.setDate(d.getDate() + 1);
  else if (preset === "next_week") d.setDate(d.getDate() + ((8 - weekday) % 7 || 7));
  else d.setDate(d.getDate() + ((6 - weekday + 7) % 7 || 7));
  return d;
}

/** A Field's value on a row as the text an action needs (an address, an order number). */
function textOf<T extends ViewThread>(
  base: ViewBase<T>,
  row: ViewRow<T>,
  ref: string,
): string | null {
  const v = readField(base.doc, row.thread, ref, base.ctx, row.lane);
  if (v.state !== "value") return null;
  const x = v.value;
  if (x && typeof x === "object") {
    if ("url" in x) return x.url;
    if ("email" in x) return x.email;
  }
  return v.text || String(x);
}

/** A date Field as an ISO moment, or null. */
function dateOf<T extends ViewThread>(
  base: ViewBase<T>,
  row: ViewRow<T>,
  ref: string,
): string | null {
  const v = readField(base.doc, row.thread, ref, base.ctx, row.lane);
  return v.state === "value" && typeof v.value === "string" && !Number.isNaN(Date.parse(v.value))
    ? v.value
    : null;
}

/** What one action does to one row. */
async function once<T extends ViewThread>(
  base: ViewBase<T>,
  d: ActionDo,
  row: ViewRow<T>,
  host: ViewActionHost,
  options: ViewActionOptions,
): Promise<UndoToken | null | "unavailable" | "no_value" | "cancelled"> {
  const id = row.thread.id;
  switch (d.kind) {
    case "archive":
      return host.archive([id]);
    case "mark_read":
      return host.markRead([id], true);
    case "mark_unread":
      return host.markRead([id], false);
    case "snooze": {
      const until =
        d.until === "tomorrow" || d.until === "next_week" || d.until === "weekend"
          ? presetMoment(d.until, base.ctx.now, options.morningHour)
          : (() => {
              const at = dateOf(base, row, d.until);
              if (!at) return null;
              // A bare day wakes at the morning hour of that day.
              const plain = /^\d{4}-\d{2}-\d{2}$/.test(at);
              const t = new Date(plain ? `${at}T00:00:00` : at);
              if (plain) t.setHours(options.morningHour);
              return t;
            })();
      if (!until || until.getTime() <= base.ctx.now.getTime()) return "no_value";
      return host.snooze([id], until);
    }
    case "move":
      return host.move([id], d.group);
    case "tag":
      return host.tag([id], d.tag);
    case "reply_template":
      host.compose("reply", id, { templateId: d.template });
      return null;
    case "forward": {
      const to = d.to.includes("@") ? d.to : textOf(base, row, d.to);
      if (!to?.includes("@")) return "no_value";
      host.compose("forward", id, { to: [{ name: "", email: to }] });
      return null;
    }
    case "open_link": {
      const url = textOf(base, row, d.link);
      if (!url) return "no_value";
      let domain = url;
      try {
        domain = new URL(url).hostname;
      } catch {
        return "no_value";
      }
      if (!(await host.confirm(fill(options.opensWords, { domain })))) return "cancelled";
      await host.openLink(url);
      return null;
    }
    case "add_to_calendar": {
      if (!host.createEvent) return "unavailable";
      const at = dateOf(base, row, d.date);
      if (!at) return "no_value";
      const plain = /^\d{4}-\d{2}-\d{2}$/.test(at);
      const start = new Date(plain ? `${at}T09:00:00` : at);
      const end = new Date(start.getTime() + options.eventMinutes * 60_000);
      const title = (d.title ? textOf(base, row, d.title) : null) ?? row.thread.subject ?? "";
      await host.createEvent({ title, start: start.toISOString(), end: end.toISOString() });
      return null;
    }
    case "run_workflow": {
      const inputs: Record<string, string> = {};
      for (const [name, ref] of Object.entries(d.inputs ?? {})) {
        const v = readField(base.doc, row.thread, ref, base.ctx, row.lane);
        inputs[name] =
          v.state === "value" ? formatFieldValue(v, undefined, base.ctx, options.words) : "";
      }
      await host.runWorkflow(d.workflow, id, inputs);
      return null;
    }
    case "custom_action":
      return (await host.customAction(d.action, id)) ? null : "unavailable";
    case "set_lane":
      await host.setLane(id, d.lane);
      return null;
    case "mark_done":
      await host.markDone(id, row.thread.messageCount);
      return null;
    case "ask_agent":
      // One sentence for every Thread; handled by runViewAction.
      return null;
  }
}

/**
 * Runs an action on one row (its button) or every row of a group (the
 * header's), for the rows its `when` holds on. The Undo tokens of the
 * reversible ones come back for one toast.
 */
export async function runViewAction<T extends ViewThread>(
  base: ViewBase<T>,
  action: ViewAction,
  rows: readonly ViewRow<T>[],
  host: ViewActionHost,
  options: ViewActionOptions,
  where: "row" | "group" = "row",
): Promise<ViewActionResult> {
  const shown = rows.filter((r) => actionShows(base, action, r, where));
  if (shown.length === 0) return { ok: false, reason: "nothing" };
  if (action.do.kind === "ask_agent") {
    const threads = shown.map((r) => r.thread.subject || r.thread.id).join("; ");
    host.ask(fill(options.askWords, { prompt: action.do.prompt, threads }));
    return { ok: true, undo: [], ran: shown.length };
  }
  // A reversible action over many Threads is one batch, so one Undo puts them all back.
  const ids = shown.map((r) => r.thread.id);
  const d = action.do;
  if (
    shown.length > 1 &&
    (d.kind === "archive" ||
      d.kind === "mark_read" ||
      d.kind === "mark_unread" ||
      d.kind === "move")
  ) {
    const token =
      d.kind === "archive"
        ? await host.archive(ids)
        : d.kind === "move"
          ? await host.move(ids, d.group)
          : await host.markRead(ids, d.kind === "mark_read");
    return { ok: true, undo: token ? [token] : [], ran: ids.length };
  }
  const undo: UndoToken[] = [];
  let ran = 0;
  for (const row of shown) {
    const out = await once(base, action.do, row, host, options);
    if (out === "unavailable" || out === "cancelled") return { ok: false, reason: out };
    if (out === "no_value") {
      if (shown.length === 1) return { ok: false, reason: "no_value" };
      continue;
    }
    if (out) undo.push(out);
    ran += 1;
  }
  return ran ? { ok: true, undo, ran } : { ok: false, reason: "no_value" };
}
