// meeting_options (docs/spec/meetings.md, "The agent"): the same logic the
// meeting chips run, as a read-only tool. "Reply to Aoife with some times
// next week" finds the Thread, then asks this for the case, the proposed
// times with free or busy, and free slots (optionally in the agent's own
// window), and writes the reply with draft_message, which asks before it
// sends; a proposed time the user is free for goes through schedule_event.

import type { MeetingOptions } from "@monday/shared";
import { isIanaZone } from "@monday/shared";
import { z } from "zod";
import type { ToolDefinition } from "./catalog.ts";

/** What the tool reads through: the meetings module on the Server. */
export interface MeetingsSeam {
  options(
    workspaceId: string,
    threadId: string,
    request?: {
      zone?: string | undefined;
      judge?: boolean | undefined;
      override?: {
        from?: Date | undefined;
        to?: Date | undefined;
        lengthMinutes?: number | undefined;
        count?: number | undefined;
      };
    },
  ): Promise<MeetingOptions>;
}

const isoDate = z.iso.datetime({ offset: true });

function wall(at: string, zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: zone,
    }).format(new Date(at));
  } catch {
    return at;
  }
}

/** The options as the tool's text: the case, each proposal, the slots and the chips the reader would show. */
export function meetingOptionsText(o: MeetingOptions): string {
  const lines = [`Case: ${o.case}. Length ${o.lengthMinutes} minutes. Times in ${o.timeZone}.`];
  if (!o.calendar) lines.push("No calendar could be read, so free and busy are unknown.");
  if (o.flags.length > 0) lines.push(`Flags: ${o.flags.join(", ")}.`);
  for (const p of o.proposals) {
    const when = p.start
      ? wall(p.start, o.timeZone)
      : `${p.day}${p.partOfDay ? ` ${p.partOfDay}` : ""}`;
    const state =
      p.free === null ? "not checked" : p.free ? "free" : `busy (${p.busyWith.join(", ")})`;
    lines.push(
      `Proposed: ${when}, ${state}, confidence ${p.confidence.toFixed(2)}${p.flags.length ? `, ${p.flags.join(", ")}` : ""}${p.start ? ` (${p.start})` : ""}`,
    );
  }
  if (o.slots.length > 0) {
    lines.push("Free slots:");
    for (const s of o.slots)
      lines.push(
        `- ${wall(s.start, o.timeZone)} to ${wall(s.end, o.timeZone).slice(-5)} (${s.start})`,
      );
  }
  if (o.chips.length > 0)
    lines.push(`The reader offers: ${o.chips.map((c) => c.kind).join(", ")}.`);
  lines.push(
    `Event: "${o.title}" with ${o.attendees.map((a) => a.name || a.email).join(", ") || "nobody"}. Write replies with draft_message and schedule with schedule_event; both ask first.`,
  );
  return lines.join("\n");
}

const meetingOptions: ToolDefinition<{
  thread_id: string;
  from?: string | undefined;
  to?: string | undefined;
  duration_minutes?: number | undefined;
  count?: number | undefined;
  time_zone?: string | undefined;
}> = {
  name: "meeting_options",
  description:
    "For a Thread about meeting: whether it asks to meet or proposes times, each proposed time resolved (in the zone the mail states, else the user's) and checked against the user's calendar (free or busy), and free slots within working hours to offer (the next days by default, or from/to for a window such as next week; duration_minutes and count override the meeting length and how many). Changes nothing. Then write the reply with draft_message using only the slots returned, or schedule a free proposed time with schedule_event.",
  tier: "read",
  input: z.object({
    thread_id: z.string().min(1),
    from: isoDate.optional(),
    to: isoDate.optional(),
    duration_minutes: z.int().min(5).max(480).optional(),
    count: z.int().min(1).max(10).optional(),
    time_zone: z
      .string()
      .max(64)
      .optional()
      .describe("IANA zone of the user, when the calendar Setting has none"),
  }),
  summarize: (i) => i.thread_id,
  async run(input, ctx) {
    const seam = ctx.extensions?.meetings;
    if (!seam)
      return { kind: "refused", text: "Meeting options are not available from this host." };
    if (input.time_zone && !isIanaZone(input.time_zone)) {
      return { kind: "refused", text: `"${input.time_zone}" is not a time zone monday knows.` };
    }
    if (input.from && input.to && Date.parse(input.to) <= Date.parse(input.from)) {
      return { kind: "refused", text: "The window ends before it starts." };
    }
    const override =
      input.from || input.to || input.duration_minutes || input.count
        ? {
            ...(input.from ? { from: new Date(input.from) } : {}),
            ...(input.to ? { to: new Date(input.to) } : {}),
            ...(input.duration_minutes ? { lengthMinutes: input.duration_minutes } : {}),
            ...(input.count ? { count: input.count } : {}),
          }
        : undefined;
    try {
      const options = await seam.options(ctx.host.workspaceId, input.thread_id, {
        ...(input.time_zone ? { zone: input.time_zone } : {}),
        ...(override ? { override } : {}),
      });
      return { kind: "result", text: meetingOptionsText(options), data: options };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: "refused", text: message };
    }
  },
};

export const MEETING_TOOLS: readonly ToolDefinition<never>[] = [
  meetingOptions as unknown as ToolDefinition<never>,
];
