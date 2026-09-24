// The Workflows page (ADR 0003, docs/spec/workflows.md): the list of
// Workflows with their trigger in plain words, status, last run and recent
// outcomes, and the selected Workflow drawn as what it is, a vertical flow
// of cards (trigger, conditions with their branches, Steps with their tool,
// summary, fields and approval). Recent Runs lay their Step results over the
// flow; a paused Run shows its approval card; Dry run, Run now, Source and
// rename sit in the head, and "Change with monday" hands a sentence to the
// composer (the Agent writes the document, there is no editor). While the AI
// level keeps Workflows paused the page says so, offers to raise it, and
// keeps every Workflow visible read-only. Data comes from the /workflows
// routes through the Api; the fixture API stands in without a Server. Every
// string is a Setting (strings.workflows.*).

import type {
  ActivityRecord,
  DryRunPreview,
  RunView,
  Settings,
  ToolCall,
  WorkflowView,
} from "@monday/shared";
import {
  AgentBar,
  AgentDock,
  AskBox,
  Btn,
  DryRunCard,
  flowGlyph,
  formatWhen,
  Icon,
  Input,
  PageHead,
  RunApprovalCard,
  RunDots,
  RunLog,
  SideCard,
  SourceView,
  Switch,
  Tag,
  WorkflowFlow,
  WorkflowStatus,
} from "@monday/ui";
import {
  ClockCounterClockwiseIcon,
  CloudIcon,
  CodeIcon,
  FlaskIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  TerminalWindowIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { cliLabel } from "../agent/runtimes/index.ts";
import { useShell } from "../shell/Shell.tsx";
import { useWorkspace } from "../workspace.tsx";
import { fill } from "./inbox/triage.ts";
import { LevelLock, useLevelLock } from "./LevelLock.tsx";
import { flowModel, flowStrings } from "./workflows/flow.ts";
import { statusLabel, workflowStatus } from "./workflows/status.ts";
import { fixtureWorkflowsApi, type WorkflowsApi } from "./workflows/workflow-data.ts";

export type { WorkflowsApi } from "./workflows/workflow-data.ts";

export interface WorkflowsProps {
  workspaceId?: string | undefined;
  /** The Server side of the page; the Shell's client by default, the fixture without a Server, a fake in tests. */
  api?: WorkflowsApi | undefined;
  /** Hands a sentence to the composer: "Change the workflow X: ..." or a new one. */
  onAsk?: ((text: string) => void) | undefined;
  onNavigate?: ((target: string) => void) | undefined;
  /** Group ids to names, for "Mail arrives in Hiring › Candidates". */
  groupName?: ((id: string) => string) | undefined;
  now?: Date | undefined;
  /**
   * The bottom agent the App owns, so asking here opens it here without
   * leaving the page; absent, a bar that hands off to the Inbox's.
   */
  agent?: ReactNode | undefined;
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
  agent,
}: WorkflowsProps) {
  const shell = useShell();
  const current = useWorkspace();
  const workspaceId = workspaceIdProp ?? current.id;
  const { settings } = shell;
  // Just mail (CONTEXT.md "AI level"): nothing here asks the Agent.
  const aiOff = settings["ai.level"] === "off";
  // Below automate nothing runs unasked: the page is locked, the Workflows kept read-only.
  const { locked, levelName } = useLevelLock();
  // The fixture stands in on the browser dev server only, where no Server exists.
  const server = shell.server !== null;
  const fallbackApi = useMemo(
    () => (server ? shell.api.workflows : fixtureWorkflowsApi()),
    [server, shell.api],
  );
  const api = apiOverride ?? fallbackApi;
  const s = useMemo(() => workflowStrings(settings), [settings]);
  const fs = useMemo(() => flowStrings(settings), [settings]);
  const now = nowProp ?? new Date();

  const [workflows, setWorkflows] = useState<WorkflowView[] | null>(null);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** The Run whose Step results lay over the flow; none shows the Workflow as written. */
  const [shownRun, setShownRun] = useState<string | null>(null);
  const [waitingCard, setWaitingCard] = useState<ActivityRecord | null>(null);
  const [dry, setDry] = useState<DryRunPreview | null>(null);
  const [source, setSource] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
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

  const list = useMemo(() => {
    // Switched on first, then by name: the list reads the same on every refresh.
    return [...(workflows ?? [])].sort(
      (a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name),
    );
  }, [workflows]);
  const selected = list.find((w) => w.id === selectedId) ?? list[0] ?? null;
  // The first Workflow shown stays selected when a change reorders the list.
  const firstId = selected?.id ?? null;
  useEffect(() => {
    if (selectedId === null && firstId !== null) setSelectedId(firstId);
  }, [selectedId, firstId]);
  const selectedRuns = selected
    ? runs
        .filter((r) => r.workflowId === selected.id)
        .slice(0, settings["workflows.page.runs_shown"])
    : [];
  const overlay = selectedRuns.find((r) => r.id === shownRun) ?? null;
  const waitingRun = selectedRuns.find((r) => r.status === "paused") ?? null;

  // The waiting Step's Activity row carries the card's preview.
  useEffect(() => {
    let cancelled = false;
    if (!waitingRun) {
      setWaitingCard(null);
      return;
    }
    api
      .runActivity(waitingRun.id)
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
  }, [api, waitingRun]);

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
  const rename = (w: WorkflowView, name: string) =>
    void act(async () => {
      await api.update(w.id, {
        name,
        sentence: w.sentence,
        kind: w.kind,
        trigger: w.trigger,
        steps: w.steps,
        placement: w.placement,
        failurePolicy: w.failurePolicy,
        standingApprovals: w.standingApprovals,
      });
      setRenaming(null);
    });

  /** Runs waiting for an approval: the Server's count, or what the loaded Runs say. */
  const waitingCount = (w: WorkflowView) =>
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

  const select = (id: string) => {
    setSelectedId(id);
    setShownRun(null);
    setDry(null);
    setSource(false);
    setRenaming(null);
  };

  const loading = workflows === null && !loadError;
  const empty = workflows !== null && list.length === 0;
  const status = (w: WorkflowView) => workflowStatus(w, runs, locked);

  const lock = locked ? (
    <LevelLock
      title={s["locked.title"] ?? ""}
      lede={s["locked.lede"] ?? ""}
      body={fill(list.length ? (s["locked.body"] ?? "") : (s["locked.body_empty"] ?? ""), {
        level: levelName,
        n: list.length,
      })}
      benefits={settings["strings.workflows.locked.benefits"]}
      illustration={<ExampleFlow lines={settings["strings.workflows.locked.example"]} />}
      onNavigate={onNavigate}
    />
  ) : null;

  const examples = (
    <div className="empty page-empty wf-empty">
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
  );

  return (
    <div className="main page">
      <div className="page-wrap">
        <div className="page-in wf-page">
          <PageHead title={s.title ?? "Workflows"} subtitle={s.subtitle}>
            <Btn outline onClick={() => onNavigate?.("activity")}>
              <Icon icon={ClockCounterClockwiseIcon} /> {s.history ?? "Run history"}
            </Btn>
            {locked ? null : (
              <Btn primary onClick={() => newWorkflow()}>
                <Icon icon={PlusIcon} /> {s.new ?? "New workflow"}
              </Btn>
            )}
          </PageHead>
          {(error ?? loadError) ? (
            <p className="faint routing-error" role="alert">
              {error ?? loadError}
            </p>
          ) : null}
          {lock}
          {loading ? (
            <p className="faint wf-loading" aria-busy="true">
              {s.loading}
            </p>
          ) : null}
          {empty && !locked ? examples : null}
          {list.length > 0 && selected ? (
            <>
              {locked ? <h2 className="wf-kept">{s["locked.kept"]}</h2> : null}
              <div className="wfx" data-locked={locked ? "true" : undefined}>
                <nav className="wfx-list" aria-label={s.list_label}>
                  {list.map((w) => {
                    const st = status(w);
                    const trig = flowModel(w, fs, { groupName }).cards[0];
                    return (
                      <button
                        type="button"
                        key={w.id}
                        className="wfx-row"
                        aria-current={selected.id === w.id ? "true" : undefined}
                        data-status={st}
                        onClick={() => select(w.id)}
                      >
                        <span className="wfx-row-icon">
                          <Icon icon={flowGlyph(trig?.icon ?? "lightning")} />
                        </span>
                        <span className="wfx-row-main">
                          <span className="wfx-row-name">
                            <b>{w.name}</b>
                            <WorkflowStatus
                              kind={st}
                              label={statusLabel(st, waitingCount(w), settings)}
                            />
                          </span>
                          <span className="wfx-row-trig">{trig?.title}</span>
                          <span className="wfx-row-foot">
                            <span>
                              {w.lastRunAt
                                ? fill(s.last_run ?? "Last run {when}", {
                                    when: ago(w.lastRunAt, now),
                                  })
                                : (s.never_ran ?? "Not run yet")}
                            </span>
                            {w.runsToday ? (
                              <span>{fill(s.today ?? "{n} today", { n: w.runsToday })}</span>
                            ) : null}
                            <RunDots
                              recent={w.recent}
                              label={
                                w.recent.length === 1
                                  ? s.runs_one
                                  : fill(s.runs_count ?? "{n} recent runs", { n: w.recent.length })
                              }
                            />
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  {locked ? null : (
                    <button type="button" className="wfx-row wfx-new" onClick={() => newWorkflow()}>
                      <span className="wfx-row-icon">
                        <Icon icon={PlusIcon} />
                      </span>
                      <span className="wfx-row-main">
                        <b>{s.new ?? "New workflow"}</b>
                        <span className="wfx-row-trig">{s.empty_title}</span>
                      </span>
                    </button>
                  )}
                </nav>
                <section className="wfx-detail" aria-label={selected.name}>
                  <header className="wfx-head">
                    <div className="wfx-title">
                      {renaming !== null ? (
                        <form
                          className="wfx-rename"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const name = renaming.trim();
                            if (name && name !== selected.name) rename(selected, name);
                            else setRenaming(null);
                          }}
                        >
                          <Input
                            value={renaming}
                            autoFocus
                            aria-label={s.rename}
                            onChange={(e) => setRenaming(e.currentTarget.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") setRenaming(null);
                            }}
                          />
                          <Btn sm primary type="submit" disabled={busy}>
                            {s.rename_save}
                          </Btn>
                          <Btn sm onClick={() => setRenaming(null)}>
                            {s.rename_cancel}
                          </Btn>
                        </form>
                      ) : (
                        <>
                          <h2>{selected.name}</h2>
                          {locked || aiOff ? null : (
                            <Btn
                              sm
                              icon
                              aria-label={s.rename}
                              title={s.rename}
                              onClick={() => setRenaming(selected.name)}
                            >
                              <Icon icon={PencilSimpleIcon} />
                            </Btn>
                          )}
                        </>
                      )}
                      <WorkflowStatus
                        kind={status(selected)}
                        label={statusLabel(status(selected), waitingCount(selected), settings)}
                      />
                    </div>
                    <div className="wfx-meta">
                      <span className="where">
                        <Icon
                          icon={
                            selected.placementInEffect === "server" ? CloudIcon : TerminalWindowIcon
                          }
                        />
                        {placementLabel(selected)}
                      </span>
                      <span>{fill(s.version ?? "Version {n}", { n: selected.version })}</span>
                      <span>
                        {selected.lastRunAt
                          ? fill(s.last_run ?? "Last run {when}", {
                              when: ago(selected.lastRunAt, now),
                            })
                          : (s.never_ran ?? "Not run yet")}
                      </span>
                    </div>
                    <div className="wfx-acts">
                      {locked ? null : (
                        <span className="wfx-switch">
                          <Switch
                            on={selected.enabled}
                            label={`${s.enable ?? "Enabled"}: ${selected.name}`}
                            disabled={busy}
                            onChange={(next) => toggle(selected, next)}
                          />
                          {s.enable}
                        </span>
                      )}
                      {locked ? null : (
                        <Btn sm onClick={() => dryRun(selected)} disabled={busy}>
                          <Icon icon={FlaskIcon} /> {s.dry_run ?? "Dry run"}
                        </Btn>
                      )}
                      {!locked && selected.trigger.kind === "manual" ? (
                        <Btn sm onClick={() => runNow(selected)} disabled={busy}>
                          <Icon icon={PlayIcon} /> {s.run_now ?? "Run now"}
                        </Btn>
                      ) : null}
                      <Btn sm on={source} onClick={() => setSource((v) => !v)}>
                        <Icon icon={CodeIcon} /> {source ? s.hide_source : (s.source ?? "Source")}
                      </Btn>
                    </div>
                  </header>
                  {selected.sentence ? (
                    <figure className="wfx-sentence">
                      <figcaption>{s.asked_for}</figcaption>
                      <blockquote>{selected.sentence}</blockquote>
                    </figure>
                  ) : null}
                  {locked || aiOff ? null : (
                    <AskBox
                      className="wfx-ask"
                      placeholder={s.ask_placeholder ?? "Ask monday to change this workflow"}
                      value={ask}
                      onChange={setAsk}
                      onSubmit={change}
                    />
                  )}
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
                  {waitingRun && !locked ? (
                    <SideCard title={s.waiting ?? "Waiting for your approval"} className="wfx-card">
                      <RunApprovalCard
                        call={waitingCall(waitingRun, waitingCard)}
                        preview={waitingCard?.preview ?? null}
                        approveLabel={s.approve ?? "Approve"}
                        standingLabel={s.standing ?? "Always allow this step"}
                        declineLabel={s.decline ?? "Decline"}
                        onDecide={(decision, standing) => decide(waitingRun, decision, standing)}
                        busy={busy}
                      />
                    </SideCard>
                  ) : null}
                  {dry ? (
                    <DryRunCard
                      className="wfx-card"
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
                  <h3 className="wfx-h">{s.flow_title}</h3>
                  {overlay ? (
                    <div className="wfx-showing" role="status">
                      <span>
                        {fill(s.showing_run ?? "", {
                          subject: runTitle(overlay, s),
                          when: ago(overlay.startedAt, now),
                        })}
                      </span>
                      <Btn sm onClick={() => setShownRun(null)}>
                        <Icon icon={XIcon} /> {s.hide_run}
                      </Btn>
                    </div>
                  ) : null}
                  <WorkflowFlow
                    label={selected.name}
                    cards={flowModel(selected, fs, { groupName, run: overlay }).cards}
                    fields={settings["workflows.page.step_details"]}
                    dim={locked || !selected.enabled}
                  />
                  {selected.standingApprovals.length && !locked ? (
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
                  <SideCard
                    title={s.recent_runs ?? "Recent runs"}
                    count={selectedRuns.length}
                    className="wfx-runs"
                  >
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
                      selectedId={overlay?.id ?? null}
                      onSelect={(id) => setShownRun(id === shownRun ? null : id)}
                    />
                  </SideCard>
                  <p className="wfx-where faint">
                    {selected.placementInEffect === "server"
                      ? fill(s.where_server ?? "", { address: current.address })
                      : fill(s.where_local ?? "", { runtime: runtimeName })}
                  </p>
                </section>
              </div>
            </>
          ) : null}
        </div>
      </div>
      {shell.layout.agent === "bottom" && !aiOff
        ? (agent ?? (
            <AgentDock>
              <AgentBar
                placeholder={settings["strings.agent.placeholder"]}
                onFocus={() => onNavigate?.("agent")}
              />
            </AgentDock>
          ))
        : null}
    </div>
  );
}

/** The locked page's faded example: a trigger and two Steps, from strings.workflows.locked.example. */
function ExampleFlow({ lines }: { lines: readonly string[] }) {
  const icons = ["envelope", "brain", "drive", "bell", "slack"];
  return (
    <WorkflowFlow
      compact
      className="wflow-example"
      cards={lines.map((line, i) => ({
        key: `${i}:${line}`,
        tone: i === 0 ? "trig" : "step",
        icon: icons[i] ?? "lightning",
        eyebrow: "",
        title: line,
        depth: 0,
      }))}
    />
  );
}
