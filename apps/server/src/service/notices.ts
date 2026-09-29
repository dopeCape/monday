// Desktop notifications from the Sidecar while monday's window is closed
// (ADR 0013). The app tells new mail and waiting Workflow approvals while it
// is open (apps/desktop/src/notifications/new-mail.ts, approvals/notices.ts);
// once no client has been connected for notifications.sidecar.absent_seconds,
// the Sidecar tells them itself, under the same notifications.* Settings of
// the client on this computer and with the same rules: only recent mail, only
// unread Threads in the Inbox, not the Account's own sends, not bulk mail
// unless the Setting says so, several at once as one notice per Workspace;
// once per waiting Step, only Steps that started waiting recently.
//
// While a client is connected the Sidecar tells nothing and moves its cursors
// along, so nothing the app saw is told later. What it did tell is reported
// on GET /service (`notified`), so the app, opened afterwards, does not tell
// it again. Runtime-neutral: the source is the database, `post` is the OS.

import type { Person, Settings } from "@monday/shared";
import { and, asc, eq, gt, inArray, max } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  accounts,
  activity,
  changes,
  messages,
  threads,
  workflowRunSteps,
  workflowRuns,
  workflows,
  workflowVersions,
  workspaces,
} from "../db/schema.ts";

export type SidecarNoticeSettings = Pick<
  Settings,
  | "notifications.enabled"
  | "notifications.new_mail"
  | "notifications.new_mail_bulk"
  | "notifications.new_mail_recent_minutes"
  | "notifications.workflow_approvals"
  | "notifications.workflow_approvals_recent_minutes"
  | "notifications.sidecar.absent_seconds"
  | "notifications.sidecar.check_seconds"
  | "strings.notifications.new_mail_many"
  | "strings.notifications.workflow_approval.title"
  | "strings.notifications.workflow_approval.body"
>;

export const SIDECAR_NOTICE_KEYS = [
  "notifications.enabled",
  "notifications.new_mail",
  "notifications.new_mail_bulk",
  "notifications.new_mail_recent_minutes",
  "notifications.workflow_approvals",
  "notifications.workflow_approvals_recent_minutes",
  "notifications.sidecar.absent_seconds",
  "notifications.sidecar.check_seconds",
  "strings.notifications.new_mail_many",
  "strings.notifications.workflow_approval.title",
  "strings.notifications.workflow_approval.body",
] as const satisfies readonly (keyof SidecarNoticeSettings)[];

/** A Message that reached the Server, with the state of its Thread now. */
export interface ArrivedMessage {
  id: string;
  workspaceId: string;
  /** The Workspace's own address: its sends are never news. */
  address: string;
  threadId: string;
  from: Person;
  date: Date;
  /** The Thread's subject, empty while the Server is locked. */
  subject: string;
  unread: boolean;
  archived: boolean;
  deleted: boolean;
  snoozed: boolean;
  bulk: boolean;
}

/** A Workflow Run paused at a Step that waits for approval. */
export interface WaitingRun {
  /** The same key the app uses (approvals/notices.ts waitingKey): `<run>:<activity or step>`. */
  key: string;
  workspaceId: string;
  workflowName: string;
  /** Zero-based. */
  stepIndex: number;
  stepName: string;
  /** What the Step wants to do: its tool and input summary, or the Step's name. */
  what: string;
  subject: string;
  /** When the Step started waiting. */
  since: Date;
}

export interface NoticeSource {
  /** Where the Changes feed stands now: nothing at or before it is news. */
  latest(): Promise<number>;
  /** Messages written after `cursor` on the Changes feed, oldest first, and the new cursor. */
  arrivedAfter(cursor: number): Promise<{ messages: ArrivedMessage[]; cursor: number }>;
  waitingRuns(): Promise<WaitingRun[]>;
}

export interface Notice {
  title: string;
  body: string;
}

export interface SidecarNoticesOptions {
  source: NoticeSource;
  settings: () => Promise<SidecarNoticeSettings>;
  /** Whether a client is connected, given how long an absence must last. */
  present: (graceMs: number) => boolean;
  post: (notice: Notice) => Promise<void>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface SidecarNotices {
  /** One check: tells what is due, or moves the cursors along while a client is here. */
  tick(): Promise<Notice[]>;
  /** What was told so far, for GET /service. */
  told(): { mailThrough: string | null; approvals: string[] };
  /** Checks every notifications.sidecar.check_seconds until stopped. */
  start(): () => void;
}

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

/** The mail notices due, one per Workspace, by the app's rules. Pure. */
export function mailNotices(
  arrived: readonly ArrivedMessage[],
  s: SidecarNoticeSettings,
  now: Date,
): Notice[] {
  if (!s["notifications.enabled"] || !s["notifications.new_mail"]) return [];
  const since = now.getTime() - s["notifications.new_mail_recent_minutes"] * 60_000;
  const byWorkspace = new Map<string, ArrivedMessage[]>();
  for (const m of arrived) {
    if (m.date.getTime() < since) continue;
    if (m.from.email.toLowerCase() === m.address.toLowerCase()) continue;
    if (!m.unread || m.archived || m.deleted || m.snoozed) continue;
    if (m.bulk && !s["notifications.new_mail_bulk"]) continue;
    const list = byWorkspace.get(m.workspaceId) ?? [];
    list.push(m);
    byWorkspace.set(m.workspaceId, list);
  }
  const out: Notice[] = [];
  for (const told of byWorkspace.values()) {
    const last = told[told.length - 1];
    if (!last) continue;
    if (told.length === 1) {
      out.push({ title: last.from.name || last.from.email, body: last.subject });
    } else {
      out.push({
        title: fill(s["strings.notifications.new_mail_many"], { n: told.length }),
        body: last.address,
      });
    }
  }
  return out;
}

/** The approval notices due and the keys now told (or deliberately skipped). Pure. */
export function approvalNotices(
  runs: readonly WaitingRun[],
  told: ReadonlySet<string>,
  s: SidecarNoticeSettings,
  now: Date,
): { notices: Notice[]; told: Set<string> } {
  const next = new Set(told);
  const notices: Notice[] = [];
  const on = s["notifications.enabled"] && s["notifications.workflow_approvals"];
  const since = now.getTime() - s["notifications.workflow_approvals_recent_minutes"] * 60_000;
  for (const run of runs) {
    if (next.has(run.key)) continue;
    next.add(run.key);
    if (!on || run.since.getTime() < since) continue;
    notices.push({
      title: fill(s["strings.notifications.workflow_approval.title"], {
        workflow: run.workflowName,
      }),
      body: fill(s["strings.notifications.workflow_approval.body"], {
        n: run.stepIndex + 1,
        step: run.stepName,
        what: run.what,
        subject: run.subject,
      }),
    });
  }
  return { notices, told: next };
}

export function createSidecarNotices(options: SidecarNoticesOptions): SidecarNotices {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  // The Changes feed position; mail already there when the Sidecar started is never news.
  let cursor = 0;
  let mailThrough: Date | null = null;
  // A Message is written again when a flag changes; each is considered once.
  const seen = new Set<string>();
  let told = new Set<string>();
  let primed = false;
  const toldByUs: string[] = [];

  const api: SidecarNotices = {
    async tick() {
      const s = await options.settings();
      const at = now();
      const runs = await options.source.waitingRuns();
      const live = new Set(runs.map((r) => r.key));
      // Keys of Runs no longer waiting are dropped, so the set stays small.
      told = new Set([...told].filter((k) => live.has(k)));
      if (!primed || options.present(s["notifications.sidecar.absent_seconds"] * 1000)) {
        // A client is here (it tells), or this is the first look: nothing now is news later.
        primed = true;
        cursor = await options.source.latest();
        for (const r of runs) told.add(r.key);
        return [];
      }
      const arrived = await options.source.arrivedAfter(cursor);
      cursor = arrived.cursor;
      const fresh = arrived.messages.filter((m) => !seen.has(m.id));
      for (const m of fresh) {
        seen.add(m.id);
        if (!mailThrough || m.date > mailThrough) mailThrough = m.date;
      }
      // Bounded: the oldest ids go first (a Set keeps insertion order).
      for (const id of seen) {
        if (seen.size <= 5000) break;
        seen.delete(id);
      }
      const due = approvalNotices(runs, told, s, at);
      for (const key of due.told) if (!told.has(key)) toldByUs.push(key);
      told = due.told;
      const notices = [...mailNotices(fresh, s, at), ...due.notices];
      for (const n of notices) {
        await options.post(n).catch((error) => log(`notification failed: ${error}`));
      }
      return notices;
    },
    told() {
      return {
        mailThrough: mailThrough?.toISOString() ?? null,
        approvals: toldByUs.filter((k) => told.has(k)),
      };
    },
    start() {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const loop = async () => {
        let seconds = 30;
        try {
          seconds = (await options.settings())["notifications.sidecar.check_seconds"];
          await api.tick();
        } catch (error) {
          log(`sidecar notices: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (stopped) return;
        timer = setTimeout(loop, seconds * 1000);
        (timer as { unref?: () => void }).unref?.();
      };
      void loop();
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      };
    },
  };
  return api;
}

/** Tool names as words, the way the approvals queue says them ("send_message" as "send message"). */
function toolWords(tool: string): string {
  return tool.replaceAll("_", " ").replace(/\./g, " ");
}

/** The database behind the notices: arrivals from the Changes feed, paused Runs with their Step. */
export function createDbNoticeSource(
  db: Db,
  subjectOf: (threadId: string) => Promise<string>,
  options: { batch?: number } = {},
): NoticeSource {
  const batch = options.batch ?? 200;
  const subject = async (threadId: string) => {
    try {
      return await subjectOf(threadId);
    } catch {
      // Locked, or the Thread went away: the notice goes out without it.
      return "";
    }
  };
  return {
    async latest() {
      const [row] = await db.select({ seq: max(changes.seq) }).from(changes);
      return row?.seq ?? 0;
    },

    async arrivedAfter(after) {
      const page = await db
        .select({ seq: changes.seq, id: changes.entityId })
        .from(changes)
        .where(and(gt(changes.seq, after), eq(changes.kind, "message")))
        .orderBy(asc(changes.seq))
        .limit(batch);
      const last = page[page.length - 1];
      const ids = [...new Set(page.map((p) => p.id))];
      if (ids.length === 0) return { messages: [], cursor: last?.seq ?? after };
      const rows = await db
        .select({
          id: messages.id,
          workspaceId: messages.workspaceId,
          threadId: messages.threadId,
          from: messages.from,
          date: messages.date,
          address: accounts.address,
          unread: threads.unread,
          archived: threads.archived,
          deleted: threads.deleted,
          snoozedUntil: threads.snoozedUntil,
          bulk: threads.bulk,
        })
        .from(messages)
        .innerJoin(threads, eq(threads.id, messages.threadId))
        .innerJoin(workspaces, eq(workspaces.id, messages.workspaceId))
        .innerJoin(accounts, eq(accounts.id, workspaces.accountId))
        .where(inArray(messages.id, ids));
      const order = new Map(ids.map((id, i) => [id, i]));
      rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      const out: ArrivedMessage[] = [];
      for (const r of rows) {
        out.push({
          id: r.id,
          workspaceId: r.workspaceId,
          address: r.address,
          threadId: r.threadId,
          from: r.from,
          date: r.date,
          subject: r.unread && !r.archived ? await subject(r.threadId) : "",
          unread: r.unread,
          archived: r.archived,
          deleted: r.deleted,
          snoozed: r.snoozedUntil !== null,
          bulk: r.bulk,
        });
      }
      return { messages: out, cursor: last?.seq ?? after };
    },

    async waitingRuns() {
      const runs = await db
        .select({
          id: workflowRuns.id,
          workspaceId: workflowRuns.workspaceId,
          workflowId: workflowRuns.workflowId,
          version: workflowRuns.version,
          currentStep: workflowRuns.currentStep,
          waitingActivityId: workflowRuns.waitingActivityId,
          subject: workflowRuns.subject,
          startedAt: workflowRuns.startedAt,
          name: workflows.name,
        })
        .from(workflowRuns)
        .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
        .where(eq(workflowRuns.status, "paused"));
      if (runs.length === 0) return [];
      const steps = await db
        .select({
          runId: workflowRunSteps.runId,
          index: workflowRunSteps.index,
          name: workflowRunSteps.name,
          detail: workflowRunSteps.detail,
          status: workflowRunSteps.status,
          at: workflowRunSteps.at,
        })
        .from(workflowRunSteps)
        .where(
          inArray(
            workflowRunSteps.runId,
            runs.map((r) => r.id),
          ),
        );
      const activityIds = runs.map((r) => r.waitingActivityId).filter((x): x is string => !!x);
      const calls = activityIds.length
        ? await db
            .select({
              id: activity.id,
              tool: activity.tool,
              summary: activity.summary,
              at: activity.at,
            })
            .from(activity)
            .where(inArray(activity.id, activityIds))
        : [];
      const callById = new Map(calls.map((c) => [c.id, c]));
      const out: WaitingRun[] = [];
      for (const run of runs) {
        // The Step marked waiting, as the Workflow routes' waitingStep reads it.
        const mine = steps.filter((s) => s.runId === run.id);
        const index = mine.find((s) => s.status === "waiting")?.index ?? run.currentStep;
        const row = mine.find((s) => s.index === index);
        let stepName = row?.name ?? "";
        if (!stepName) {
          const [version] = await db
            .select({ document: workflowVersions.document })
            .from(workflowVersions)
            .where(
              and(
                eq(workflowVersions.workflowId, run.workflowId),
                eq(workflowVersions.version, run.version),
              ),
            );
          const doc = version?.document as { steps?: Array<{ name?: string }> } | undefined;
          stepName = doc?.steps?.[index]?.name ?? "";
        }
        const call = run.waitingActivityId ? callById.get(run.waitingActivityId) : undefined;
        const summary = call?.summary.trim() ?? "";
        const what = call
          ? summary
            ? `${toolWords(call.tool)} ${summary}`
            : toolWords(call.tool)
          : row?.detail || stepName;
        out.push({
          key: `${run.id}:${run.waitingActivityId ?? index}`,
          workspaceId: run.workspaceId,
          workflowName: run.name,
          stepIndex: index,
          stepName,
          what,
          subject: run.subject,
          since: call?.at ?? row?.at ?? run.startedAt,
        });
      }
      return out;
    },
  };
}
