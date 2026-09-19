// The Workflows page's data seam: the Server's /workflows routes through the
// Api in the app, and a fixture implementation (the four Workflows of the
// design mock, design/js/data.js, as the documents the Agent would have
// written) for tests, the dev server and the screenshot check.

import type { DryRunPreview, RunView, WorkflowInputRaw, WorkflowView } from "@monday/shared";
import { parseWorkflowInput } from "@monday/shared";
import type { Api } from "../../platform/api.ts";

export type WorkflowsApi = Api["workflows"];

const NOW = new Date("2026-09-16T10:00:00");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

const documents: Array<{ id: string; enabled: boolean; input: WorkflowInputRaw }> = [
  {
    id: "w1",
    enabled: true,
    input: {
      name: "Candidate intake",
      sentence:
        "When a candidate emails about any open role, extract name, role and links, post a summary to the Hiring Notion database, label the thread and ping #hiring on Slack if the role is Rust.",
      trigger: { kind: "arrival", group: "candidates" },
      steps: [
        {
          id: "extract",
          kind: "agentic",
          name: "Extract",
          prompt: "Extract the candidate's name, the role and any links.",
          tools: ["read_thread"],
          outputs: ["name", "role", "links"],
        },
        {
          id: "notion",
          kind: "notion",
          name: "Notion",
          database: "Hiring",
          properties: { Name: "{{steps.extract.name}}", Role: "{{steps.extract.role}}" },
        },
        {
          id: "rust",
          kind: "condition",
          name: "If role is Rust",
          when: { left: "{{steps.extract.role}}", op: "contains", value: "rust" },
        },
        {
          id: "slack",
          kind: "slack",
          name: "Slack",
          channel: "#hiring",
          text: "New candidate: {{steps.extract.name}} for {{steps.extract.role}}",
        },
      ],
      placement: "server",
      standingApprovals: ["notion"],
    },
  },
  {
    id: "w2",
    enabled: true,
    input: {
      name: "Invoices to Drive",
      sentence:
        "Save every invoice or receipt PDF into Google Drive under Finance/2026, rename it to vendor-date-amount, and reply to accounting on the first of each month with the list.",
      trigger: { kind: "arrival", group: "finance", predicate: { hasAttachment: true } },
      steps: [
        {
          id: "read",
          kind: "agentic",
          name: "Read",
          prompt: "Read the invoice and report the vendor, date and amount.",
          tools: ["read_thread"],
          outputs: ["vendor", "date", "amount"],
        },
        {
          id: "drive",
          kind: "drive",
          name: "Drive",
          folder: "Finance/2026",
          fileName: "{{steps.read.vendor}}-{{steps.read.date}}-{{steps.read.amount}}.pdf",
        },
      ],
      placement: "server",
      standingApprovals: ["drive"],
    },
  },
  {
    id: "w3",
    enabled: true,
    input: {
      name: "Investor follow-up nudge",
      sentence:
        "If an email in Investors has no reply from me after 2 working days, draft a follow-up in my voice and leave it in Drafts, then remind me at 9am.",
      trigger: { kind: "silence", days: 2, group: "investors" },
      steps: [
        {
          id: "draft",
          kind: "draft_reply",
          name: "Draft",
          instructions: "A short, warm follow-up asking whether they had a chance to look.",
        },
        { id: "remind", kind: "notify", name: "Remind", text: "Follow up: {{thread.subject}}" },
      ],
      placement: "local",
    },
  },
  {
    id: "w4",
    enabled: false,
    input: {
      name: "Newsletter digest",
      sentence:
        "Every Friday at 16:00 summarize the week's newsletters into one email to myself, then archive the originals.",
      trigger: { kind: "schedule", cron: "0 16 * * fri" },
      steps: [
        {
          id: "summarize",
          kind: "agentic",
          name: "Summarize",
          prompt:
            "Summarize this week's newsletters into one email to me and archive the originals.",
          tools: [
            "search_threads",
            "read_thread",
            "draft_message",
            "send_draft",
            "archive_threads",
          ],
        },
      ],
      placement: "local",
    },
  },
];

function viewOf(
  entry: { id: string; enabled: boolean; input: WorkflowInputRaw },
  runs: RunView[],
): WorkflowView {
  const parsed = parseWorkflowInput(entry.input);
  if (!parsed.ok) throw new Error(`fixture ${entry.id}: ${parsed.error}`);
  const own = runs.filter((r) => r.workflowId === entry.id);
  return {
    ...parsed.value,
    id: entry.id,
    workspaceId: "ws",
    version: 1,
    enabled: entry.enabled,
    placementInEffect: parsed.value.placement ?? "server",
    createdAt: minutesAgo(60 * 24 * 30),
    updatedAt: minutesAgo(60 * 24),
    lastRunAt: own[0]?.startedAt ?? null,
    runsToday: own.filter((r) => r.startedAt.slice(0, 10) === NOW.toISOString().slice(0, 10))
      .length,
    recent: own
      .slice()
      .reverse()
      .map((r) => (r.status === "queued" ? "running" : r.status)),
    paused: own.filter((r) => r.status === "paused").length,
  };
}

const run = (
  id: string,
  workflowId: string,
  startedAt: string,
  status: RunView["status"],
  subject: string,
  steps: Array<[string, RunView["steps"][number]["status"], string]>,
): RunView => ({
  id,
  workflowId,
  workspaceId: "ws",
  version: 1,
  status,
  trigger: { kind: "arrival", threadId: `t-${id}` },
  threadId: `t-${id}`,
  subject,
  currentStep: steps.length - 1,
  failedStep: status === "failed" ? steps.findIndex((s) => s[1] === "failed") : null,
  waitingActivityId: status === "paused" ? `a-${id}` : null,
  waitingStep: status === "paused" ? steps.findIndex((s) => s[1] === "waiting") : null,
  error: status === "failed" ? (steps.find((s) => s[1] === "failed")?.[2] ?? null) : null,
  steps: steps.map(([name, stepStatus, detail], index) => ({
    index,
    stepId: name.toLowerCase(),
    name,
    kind: "notify",
    status: stepStatus,
    detail,
    activityId: null,
    at: startedAt,
  })),
  startedAt,
  finishedAt: status === "done" || status === "failed" ? startedAt : null,
});

export const fixtureRuns: RunView[] = [
  run("r1", "w1", minutesAgo(9), "done", "Aoife Brennan, Senior Rust engineer", [
    ["Extract", "done", "name: Aoife Brennan, role: Senior Rust engineer"],
    ["Notion", "done", "Row added to Hiring"],
    ["If role is Rust", "done", "Yes: Senior Rust engineer"],
    ["Slack", "done", "Posted to #hiring"],
  ]),
  run("r2", "w1", "2026-09-15T17:21:00", "done", "Ngozi Adeyemi, Design Engineer", [
    ["Extract", "done", "name: Ngozi Adeyemi, role: Design Engineer"],
    ["Notion", "done", "Row added to Hiring"],
    ["If role is Rust", "done", "No: Design Engineer"],
    ["Slack", "skipped", "Skipped: If role is Rust said no"],
  ]),
  run("r3", "w1", "2026-09-13T10:04:00", "failed", "Unknown sender, no role detected", [
    ["Extract", "failed", "Skipped: confidence 0.31, asked you to confirm"],
  ]),
  run("r4", "w2", "2026-09-14T06:01:00", "done", "Hetzner, 41.60 EUR", [
    ["Read", "done", "vendor: Hetzner, amount: 41.60 EUR"],
    ["Drive", "done", "Saved as hetzner-2026-09-41.60.pdf"],
  ]),
  run("r5", "w2", "2026-09-13T03:13:00", "done", "Anthropic, 48.00 USD", [
    ["Read", "done", "vendor: Anthropic, amount: 48.00 USD"],
    ["Drive", "done", "Saved as anthropic-2026-08-48.00.pdf"],
  ]),
  run("r6", "w3", "2026-09-11T09:00:00", "done", "Meridian Fund intro", [
    ["Draft", "done", "Draft left in Drafts"],
    ["Remind", "done", "Reminder fired"],
  ]),
  run("r7", "w4", "2026-09-05T16:00:00", "done", "7 newsletters", [
    ["Summarize", "done", "Digest sent, originals archived"],
  ]),
];

export const fixtureWorkflows: WorkflowView[] = documents.map((d) => viewOf(d, fixtureRuns));

/** The fixture API: the mock's Workflows and Runs, with every write answered in memory. */
export function fixtureWorkflowsApi(): WorkflowsApi & { calls: string[] } {
  const calls: string[] = [];
  const views = new Map(fixtureWorkflows.map((w) => [w.id, { ...w }]));
  const runs = [...fixtureRuns];
  const view = (id: string): WorkflowView => {
    const w = views.get(id);
    if (!w) throw new Error(`no workflow ${id}`);
    return w;
  };
  return {
    calls,
    list: async () => [...views.values()],
    get: async (id) => view(id),
    create: async (_w, input) => {
      calls.push(`create:${input.name}`);
      const made = viewOf({ id: `w${views.size + 1}`, enabled: false, input }, []);
      views.set(made.id, made);
      return made;
    },
    update: async (id, input) => {
      calls.push(`update:${id}`);
      const next = {
        ...viewOf({ id, enabled: view(id).enabled, input }, runs),
        version: view(id).version + 1,
      };
      views.set(id, next);
      return next;
    },
    remove: async (id) => {
      calls.push(`remove:${id}`);
      views.delete(id);
    },
    enable: async (id, enabled) => {
      calls.push(`enable:${id}:${enabled}`);
      const next = { ...view(id), enabled };
      views.set(id, next);
      return next;
    },
    version: async (id, version) => {
      const { id: _i, ...rest } = view(id);
      return { version, document: rest };
    },
    dryRun: async (id, recent) => {
      calls.push(`dry:${id}:${recent ?? ""}`);
      const preview: DryRunPreview = {
        workflowId: id,
        version: view(id).version,
        considered: 2,
        threads: [
          {
            threadId: "e1",
            subject: "Re: Senior Rust engineer role",
            from: "Aoife Brennan <aoife@northlight.dev>",
            steps: view(id).steps.map((s, index) => ({
              index,
              stepId: s.id,
              name: s.name,
              kind: s.kind,
              status: s.kind === "slack" ? "would_ask" : "would_apply",
              detail: `${s.name} would run`,
            })),
          },
        ],
      };
      return preview;
    },
    run: async (id, threadId) => {
      calls.push(`run:${id}:${threadId ?? ""}`);
      const made = run(`r${runs.length + 1}`, id, new Date().toISOString(), "queued", "", []);
      runs.unshift(made);
      return made;
    },
    standing: async (id, step, granted) => {
      calls.push(`standing:${id}:${step}:${granted}`);
      const current = view(id);
      const next = {
        ...current,
        standingApprovals: granted
          ? [...new Set([...current.standingApprovals, step])]
          : current.standingApprovals.filter((s) => s !== step),
      };
      views.set(id, next);
      return next;
    },
    runs: async (_w, options = {}) =>
      runs.filter(
        (r) =>
          (!options.workflowId || r.workflowId === options.workflowId) &&
          (!options.status || r.status === options.status),
      ),
    runOf: async (runId) => {
      const found = runs.find((r) => r.id === runId);
      if (!found) throw new Error(`no run ${runId}`);
      return found;
    },
    runActivity: async (runId) => {
      const found = runs.find((r) => r.id === runId);
      if (!found?.waitingActivityId) return [];
      return [
        {
          id: found.waitingActivityId,
          workspaceId: "ws",
          sessionId: null,
          runId,
          tool: "post_to_slack",
          tier: "always-ask",
          inputSummary: "#hiring",
          status: "waiting",
          approvedBy: null,
          undoable: false,
          undoneAt: null,
          actor: "automation",
          callId: "step-3",
          input: { channel: "#hiring" },
          preview: {
            kind: "text",
            text: `Slack #hiring:\nNew candidate: ${found.subject}`,
          },
          decision: null,
          at: found.startedAt,
        },
      ];
    },
    decide: async (runId, decision, standing = false) => {
      calls.push(`decide:${runId}:${decision}:${standing}`);
      const found = runs.find((r) => r.id === runId);
      if (!found) throw new Error(`no run ${runId}`);
      const next: RunView = {
        ...found,
        status: decision === "approved" ? "done" : "failed",
        waitingActivityId: null,
        waitingStep: null,
        steps: found.steps.map((s) =>
          s.status === "waiting"
            ? { ...s, status: decision === "approved" ? "done" : "failed" }
            : s,
        ),
      };
      runs.splice(runs.indexOf(found), 1, next);
      return next;
    },
  };
}
