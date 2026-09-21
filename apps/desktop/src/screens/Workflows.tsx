// The Workflows page (ADR 0003; design/js/screens/workflows.js): the list
// with its enabled switches and Placement, a Workflow's chain rendered
// read-only from its document, the "Change with monday" ask box that hands
// the sentence to the composer (the Agent writes the document, there is no
// editor), the Run log with Step results and the approval card a paused Run
// waits on, the Dry run preview and the Source view. Data comes from the
// /workflows routes through the Api; the fixture API stands in without a
// Server. Every string is a Setting (strings.workflows.*).

import type {
  ActivityRecord,
  DryRunPreview,
  RunView,
  Settings,
  ToolCall,
  WorkflowView,
} from "@monday/shared";
import { describeWorkflow } from "@monday/shared";
import {
  AgentBar,
  AgentDock,
  AskBox,
  Btn,
  DryRunCard,
  flowNodesOf,
  formatWhen,
  Icon,
  PageHead,
  RunApprovalCard,
  RunLog,
  RunSteps,
  SideCard,
  SourceView,
  Tabs,
  Tag,
  WorkflowCard,
} from "@monday/ui";
import { ClockCounterClockwiseIcon, FlaskIcon, PlayIcon, PlusIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cliLabel } from "../agent/runtimes/index.ts";
import { useShell } from "../shell/Shell.tsx";
import { useWorkspace } from "../workspace.tsx";
import { fill } from "./inbox/triage.ts";
import { fixtureWorkflowsApi, type WorkflowsApi } from "./workflows/workflow-data.ts";

export type { WorkflowsApi } from "./workflows/workflow-data.ts";

export interface WorkflowsProps {
  workspaceId?: string | undefined;
  /** The Server side of the page; the Shell's client by default, the fixture without a Server, a fake in tests. */
  api?: WorkflowsApi | undefined;
  /** Hands a sentence to the composer: "Change the workflow X: ..." or a new one. */
  onAsk?: ((text: string) => void) | undefined;
  onNavigate?: ((target: string) => void) | undefined;
  /** Group ids to names, for the chain's "matches Hiring › Candidates". */
  groupName?: ((id: string) => string) | undefined;
  now?: Date | undefined;
}

type Strings = Record<string, string>;

function workflowStrings(settings: Settings): Strings {
  const out: Strings = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith("strings.workflows.") && typeof value === "string") {
      out[key.slice("strings.workflows.".length)] = value;
    }
  }
  return out;
}

/** "9 min ago", "Yesterday 17:21", "Sep 5 16:00". */
function ago(iso: string, now: Date): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (ms >= 0 && ms < 60 * 60_000) return `${Math.max(1, Math.round(ms / 60_000))} min ago`;
  return formatWhen(iso, now);
}

function runTitle(run: RunView, s: Strings): string {
  if (run.subject) return run.subject;
  switch (run.trigger.kind) {
    case "schedule":
      return formatWhen(run.trigger.at);
    case "manual":
      return s.run_now ?? "Run now";
    default:
      return run.trigger.kind;
  }
}

function runDetail(run: RunView, s: Strings): string {
  if (run.status === "paused") return s.waiting ?? "Waiting for your approval";
  if (run.status === "failed") return run.error ?? s["status.failed"] ?? "Failed";
  const last = [...run.steps].reverse().find((st) => st.status === "done");
  return last?.detail ?? s[`status.${run.status}`] ?? run.status;
}

export function Workflows({
  workspaceId: workspaceIdProp,
  api: apiOverride,
  onAsk,
  onNavigate,
  groupName,
  now: nowProp,
}: WorkflowsProps) {
  const shell = useShell();
  const current = useWorkspace();
  const workspaceId = workspaceIdProp ?? current.id;
  const { settings } = shell;
  // Just mail (CONTEXT.md "AI level"): the Workflows stay listed, nothing here asks the Agent.
  const aiOff = settings["ai.level"] === "off";
  // The fixture stands in on the browser dev server only, where no Server exists.
  const server = shell.server !== null;
  const fallbackApi = useMemo(
    () => (server ? shell.api.workflows : fixtureWorkflowsApi()),
    [server, shell.api],
  );
  const api = apiOverride ?? fallbackApi;
  const s = useMemo(() => workflowStrings(settings), [settings]);
  const now = nowProp ?? new Date();

  const [workflows, setWorkflows] = useState<WorkflowView[] | null>(null);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [tab, setTab] = useState<"active" | "paused">("active");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [waitingCard, setWaitingCard] = useState<ActivityRecord | null>(null);
  const [dry, setDry] = useState<DryRunPreview | null>(null);
  const [source, setSource] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The last action that failed; cleared by the next action, never by a refresh. */
  const [error, setError] = useState<string | null>(null);
  /** Why the list could not load; cleared by the next load that succeeds. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ask, setAsk] = useState("");

  const fail = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const [list, recent] = await Promise.all([api.list(workspaceId), api.runs(workspaceId)]);
      setWorkflows(list);
      setRuns(recent);
      setLoadError(null);
    } catch (e) {
      setLoadError(
        fill(s.load_failed ?? "Could not load your workflows: {message}", {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }, [api, workspaceId, s.load_failed]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const every = settings["workflows.page.refresh_seconds"];
  useEffect(() => {
    if (!every) return;
    const id = setInterval(() => void refresh(), every * 1000);
    return () => clearInterval(id);
  }, [every, refresh]);

  const list = workflows ?? [];
  const active = list.filter((w) => w.enabled);
  const pausedList = list.filter((w) => !w.enabled);
  const shown = tab === "active" ? active : pausedList;
  const selected = list.find((w) => w.id === selectedId) ?? shown[0] ?? list[0] ?? null;
  const selectedRuns = selected ? runs.filter((r) => r.workflowId === selected.id) : [];
  const openRun = selectedRuns.find((r) => r.id === selectedRun) ?? selectedRuns[0] ?? null;

  // The waiting Step's Activity row carries the card's preview.
  useEffect(() => {
    let cancelled = false;
    if (openRun?.status !== "paused") {
      setWaitingCard(null);
      return;
    }
    api
      .runActivity(openRun.id)
      .then((rows) => {
        if (cancelled) return;
        setWaitingCard(rows.find((r) => r.status === "waiting") ?? null);
      })
      .catch(() => {
        if (!cancelled) setWaitingCard(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api, openRun]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (w: WorkflowView, enabled: boolean) => void act(() => api.enable(w.id, enabled));
  const decide = (run: RunView, decision: "approved" | "declined", standing: boolean) =>
    void act(() => api.decide(run.id, decision, standing));
  const dryRun = (w: WorkflowView) =>
    void act(async () => {
      setDry(await api.dryRun(w.id));
    });
  const runNow = (w: WorkflowView) => void act(() => api.run(w.id, null));
  const revoke = (w: WorkflowView, step: string) => void act(() => api.standing(w.id, step, false));

  /** Runs waiting for an approval: the Server's count, or what the loaded Runs say. */
  const pausedCount = (w: WorkflowView) =>
    Math.max(w.paused, runs.filter((r) => r.workflowId === w.id && r.status === "paused").length);

  const runtimeName = cliLabel(settings["ai.local.cli"]);
  const placementLabel = (w: WorkflowView) =>
    w.placementInEffect === "server"
      ? (s.runs_on_server ?? "Runs on your server")
      : fill(s.runs_on_local ?? "Runs here via {runtime}", { runtime: runtimeName });

  const change = (text: string) => {
    const sentence = text.trim();
    if (!sentence || !selected) return;
    onAsk?.(
      `${fill(s.change_prefix ?? 'Change the workflow "{name}": ', { name: selected.name })}${sentence}`,
    );
    setAsk("");
  };
  const newWorkflow = (sentence?: string) =>
    onAsk?.(`${s.new_prompt ?? "Write a new workflow: "}${sentence ?? ""}`);

  const stepName = (run: RunView) =>
    run.steps.find((st) => st.index === run.waitingStep)?.name ?? "";

  const waitingCall = (run: RunView, row: ActivityRecord | null): ToolCall => ({
    id: row?.id ?? run.waitingActivityId ?? run.id,
    sessionId: null,
    runId: run.id,
    tool: row?.tool ?? stepName(run),
    tier: row?.tier ?? "always-ask",
    inputSummary: row?.inputSummary ?? run.subject,
    status: "waiting",
    approvedBy: null,
    undoable: false,
  });

  return (
    <div className="main page">
      <div className="page-wrap">
        <div className="page-in">
          <PageHead title={s.title ?? "Workflows"} subtitle={s.subtitle}>
            <Btn outline onClick={() => onNavigate?.("activity")}>
              <Icon icon={ClockCounterClockwiseIcon} /> {s.history ?? "Run history"}
            </Btn>
            <Btn primary onClick={() => newWorkflow()}>
              <Icon icon={PlusIcon} /> {s.new ?? "New workflow"}
            </Btn>
          </PageHead>
          {(error ?? loadError) ? (
            <p className="faint routing-error" role="alert">
              {error ?? loadError}
            </p>
          ) : null}
          <div className="two">
            <div>
              <Tabs
                items={[
                  { key: "active", label: s.active ?? "Active", count: active.length },
                  { key: "paused", label: s.paused ?? "Paused", count: pausedList.length },
                ]}
                active={tab}
                onChange={setTab}
                className="wf-tabs"
              />
              <div className="wf" aria-busy={workflows === null && !loadError ? "true" : undefined}>
                {workflows === null && !loadError ? (
                  <p className="faint wf-loading">{s.loading}</p>
                ) : null}
                {shown.map((w) => (
                  <WorkflowCard
                    key={w.id}
                    name={w.name}
                    sentence={w.sentence}
                    nodes={flowNodesOf(describeWorkflow(w, groupName))}
                    enabled={w.enabled}
                    placement={w.placementInEffect}
                    placementLabel={placementLabel(w)}
                    todayLabel={
                      w.runsToday ? fill(s.today ?? "{n} today", { n: w.runsToday }) : undefined
                    }
                    waitingLabel={
                      pausedCount(w)
                        ? fill(s.waiting_tag ?? "{n} waiting", { n: pausedCount(w) })
                        : undefined
                    }
                    pausedLabel={s.paused_tag ?? "Paused"}
                    lastRunLabel={
                      w.lastRunAt
                        ? fill(s.last_run ?? "Last run {when}", { when: ago(w.lastRunAt, now) })
                        : (s.never_ran ?? "Not run yet")
                    }
                    selected={selected?.id === w.id}
                    onSelect={() => {
                      setSelectedId(w.id);
                      setSelectedRun(null);
                      setDry(null);
                      setSource(false);
                    }}
                    onToggle={(enabled) => toggle(w, enabled)}
                    enableLabel={`${s.enable ?? "Enabled"}: ${w.name}`}
                    busy={busy}
                  />
                ))}
              </div>
              <div className="empty page-empty">
                <h3>{s.empty_title ?? "Describe the next one"}</h3>
                <p>{s.empty_body}</p>
                <div className="examples">
                  {settings["strings.workflows.examples"].map((example) => (
                    <button type="button" key={example} onClick={() => newWorkflow(example)}>
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <aside>
              {selected ? (
                <>
                  <SideCard
                    title={selected.name}
                    action={
                      <Btn sm on={source} onClick={() => setSource((v) => !v)}>
                        {s.source ?? "Source"}
                      </Btn>
                    }
                  >
                    {aiOff ? null : (
                      <AskBox
                        placeholder={s.ask_placeholder ?? "Ask monday to change this workflow"}
                        value={ask}
                        onChange={setAsk}
                        onSubmit={change}
                      />
                    )}
                    <div className="wf-meta">
                      <span className="faint">
                        {fill(s.version ?? "Version {n}", { n: selected.version })}
                      </span>
                      <Btn sm onClick={() => dryRun(selected)} disabled={busy}>
                        <Icon icon={FlaskIcon} /> {s.dry_run ?? "Dry run"}
                      </Btn>
                      {selected.trigger.kind === "manual" ? (
                        <Btn sm onClick={() => runNow(selected)} disabled={busy}>
                          <Icon icon={PlayIcon} /> {s.run_now ?? "Run now"}
                        </Btn>
                      ) : null}
                    </div>
                    {selected.standingApprovals.length ? (
                      <div className="wf-standing">
                        {selected.standingApprovals.map((step) => (
                          <span key={step} className="wf-standing-row">
                            <Tag kind="ok">{s.standing_on ?? "Standing approval"}</Tag>{" "}
                            {selected.steps.find((st) => st.id === step)?.name ?? step}
                            <Btn sm onClick={() => revoke(selected, step)} disabled={busy}>
                              {s.revoke ?? "Revoke"}
                            </Btn>
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {source ? (
                      <SourceView
                        document={{
                          name: selected.name,
                          sentence: selected.sentence,
                          kind: selected.kind,
                          trigger: selected.trigger,
                          steps: selected.steps,
                          placement: selected.placement,
                          failurePolicy: selected.failurePolicy,
                          standingApprovals: selected.standingApprovals,
                        }}
                      />
                    ) : null}
                  </SideCard>
                  {dry ? (
                    <DryRunCard
                      title={fill(s.dry_run_title ?? "Dry run over {n} threads", {
                        n: dry.threads.length,
                      })}
                      note={s.dry_run_note ?? ""}
                      threads={dry.threads.map((t) => ({
                        ...t,
                        judged: t.judged?.map((j) =>
                          j.probability === null
                            ? fill(s.dry_run_judged_none ?? "{statement}: no judge ({reason})", {
                                statement: j.statement,
                                reason: j.reason ?? "",
                              })
                            : fill(s.dry_run_judged ?? "{statement}: {pct}%", {
                                statement: j.statement,
                                pct: Math.round(j.probability * 100),
                              }),
                        ),
                      }))}
                      notStartedLabel={s.dry_run_not_started ?? ""}
                      emptyLabel={s.dry_run_empty ?? ""}
                      closeLabel={s.decline ?? "Close"}
                      onClose={() => setDry(null)}
                    />
                  ) : null}
                  {openRun?.status === "paused" ? (
                    <SideCard title={s.waiting ?? "Waiting for your approval"}>
                      <RunApprovalCard
                        call={waitingCall(openRun, waitingCard)}
                        preview={waitingCard?.preview ?? null}
                        approveLabel={s.approve ?? "Approve"}
                        standingLabel={s.standing ?? "Always allow this step"}
                        declineLabel={s.decline ?? "Decline"}
                        onDecide={(decision, standing) => decide(openRun, decision, standing)}
                        busy={busy}
                      />
                    </SideCard>
                  ) : null}
                  <SideCard title={s.recent_runs ?? "Recent runs"} count={selectedRuns.length}>
                    <RunLog
                      runs={selectedRuns.map((r) => ({
                        id: r.id,
                        status: r.status,
                        title: runTitle(r, s),
                        detail: runDetail(r, s),
                        when: ago(r.startedAt, now),
                        versionLabel:
                          r.version !== selected.version
                            ? fill(s.version ?? "Version {n}", { n: r.version })
                            : undefined,
                      }))}
                      emptyLabel={s.never_ran ?? "Not run yet"}
                      selectedId={openRun?.id ?? null}
                      onSelect={(id) => setSelectedRun(id === selectedRun ? null : id)}
                    />
                    {openRun && selectedRun === openRun.id ? (
                      <RunSteps steps={openRun.steps} className="wf-run-steps" />
                    ) : null}
                  </SideCard>
                  <SideCard title={s.where ?? "Where it runs"}>
                    <div className="note">
                      <div>
                        {selected.placementInEffect === "server"
                          ? fill(s.where_server ?? "", { address: current.address })
                          : fill(s.where_local ?? "", { runtime: runtimeName })}
                      </div>
                    </div>
                  </SideCard>
                </>
              ) : (
                <SideCard title={s.title ?? "Workflows"}>
                  <p className="faint">
                    {workflows === null && !loadError ? s.loading : s.none_selected}
                  </p>
                </SideCard>
              )}
            </aside>
          </div>
        </div>
      </div>
      {shell.layout.agent === "bottom" && !aiOff ? (
        <AgentDock>
          <AgentBar
            placeholder={settings["strings.agent.placeholder"]}
            onFocus={() => onNavigate?.("agent")}
          />
        </AgentDock>
      ) : null}
    </div>
  );
}
