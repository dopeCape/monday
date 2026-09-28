// Run history, the view beside the Workflow list on the Workflows page
// (docs/spec/workflows.md): every Workflow's Runs, newest first, each with
// its Workflow's name, the Thread it was about, what started it, its state
// (running, waiting, done, failed), when and how long; a failed Run says the
// Step it stopped at and its error. Picking a Run lays its Step results over
// the flow of the version it ran under, the same cards as the Workflow's own
// page. A failed Run can run again: the same Workflow, on the same Thread.
// Escape closes the Run, and from the list goes back to the Workflows.

import type { RunView, Settings, WorkflowSketch, WorkflowView } from "@monday/shared";
import { Btn, Icon, type IconComponent, RunSteps, WorkflowFlow } from "@monday/ui";
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  EnvelopeSimpleIcon,
  HourglassIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { fill } from "../inbox/triage.ts";
import { flowModel, flowStrings } from "./flow.ts";
import {
  durationLine,
  failedStepLine,
  type HistoryState,
  historyState,
  historyStrings,
  newestRuns,
  stateLabel,
  triggerLabel,
} from "./run-history.ts";
import type { WorkflowsApi } from "./workflow-data.ts";

const STATE_ICON: Record<HistoryState, IconComponent> = {
  running: CircleNotchIcon,
  waiting: HourglassIcon,
  done: CheckCircleIcon,
  failed: WarningCircleIcon,
};

export interface RunHistoryProps {
  /** Every Workflow's Runs as the Server lists them; null while they load. */
  runs: readonly RunView[] | null;
  workflows: readonly WorkflowView[];
  api: Pick<WorkflowsApi, "version">;
  settings: Settings;
  /** "9 min ago", "Yesterday 17:21". */
  when: (iso: string) => string;
  groupName?: ((id: string) => string) | undefined;
  onOpenThread?: ((threadId: string) => void) | undefined;
  onOpenWorkflow: (workflowId: string) => void;
  /** Starts the Run's Workflow again on its Thread; absent hides "Run again". */
  onRunAgain?: ((run: RunView) => void) | undefined;
  /** An action is in flight: "Run again" waits for it. */
  busy?: boolean | undefined;
  /** Escape with no Run open: back to the Workflow list. */
  onBack: () => void;
}

/** Whether a key press belongs to a field the user is typing in. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

export function RunHistory({
  runs,
  workflows,
  api,
  settings,
  when,
  groupName,
  onOpenThread,
  onOpenWorkflow,
  onRunAgain,
  busy = false,
  onBack,
}: RunHistoryProps) {
  const s = useMemo(() => historyStrings(settings), [settings]);
  const fs = useMemo(() => flowStrings(settings), [settings]);
  const shown = useMemo(
    () => (runs ? newestRuns(runs, settings["workflows.page.history_shown"]) : []),
    [runs, settings],
  );
  const byId = useMemo(() => new Map(workflows.map((x) => [x.id, x])), [workflows]);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = shown.find((r) => r.id === openId) ?? null;
  const workflow = open ? (byId.get(open.workflowId) ?? null) : null;

  // A Run under an older version lays over the document it ran under, not today's.
  const [older, setOlder] = useState<{ key: string; doc: WorkflowSketch } | null>(null);
  const versionKey =
    open && workflow && open.version !== workflow.version ? `${workflow.id}@${open.version}` : null;
  const openWorkflowId = open?.workflowId ?? null;
  const openVersion = open?.version ?? null;
  useEffect(() => {
    if (!versionKey || openWorkflowId === null || openVersion === null) return;
    // Fetched once per version, not on every refresh of the Runs.
    if (older?.key === versionKey) return;
    let live = true;
    api
      .version(openWorkflowId, openVersion)
      .then((v) => {
        if (live) setOlder({ key: versionKey, doc: v.document });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, versionKey, openWorkflowId, openVersion, older?.key]);
  const doc: WorkflowSketch | null = versionKey && older?.key === versionKey ? older.doc : workflow;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || typing(e.target)) return;
      e.preventDefault();
      if (openId !== null) setOpenId(null);
      else onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, onBack]);

  const nameOf = (run: RunView) =>
    byId.get(run.workflowId)?.name ?? s["strings.workflows.run_history.removed"];
  const subjectOf = (run: RunView) =>
    run.subject || (run.threadId ? "" : s["strings.workflows.run_history.no_thread"]);

  if (runs === null) {
    return (
      <p className="faint wf-loading" aria-busy="true">
        {s["strings.workflows.run_history.loading"]}
      </p>
    );
  }
  if (shown.length === 0) {
    return (
      <div className="empty page-empty wf-empty wfh-empty">
        <h3>{s["strings.workflows.run_history.empty_title"]}</h3>
        <p>{s["strings.workflows.run_history.empty_body"]}</p>
      </div>
    );
  }

  return (
    <div className="wfx wfh">
      <nav className="wfx-list wfh-list" aria-label={settings["strings.workflows.history"]}>
        {shown.map((run) => {
          const state = historyState(run);
          const failedAt = failedStepLine(run, s);
          return (
            <button
              type="button"
              key={run.id}
              className="wfx-row wfh-row"
              data-run={run.id}
              data-state={state}
              aria-current={run.id === openId ? "true" : undefined}
              onClick={() => setOpenId(run.id === openId ? null : run.id)}
            >
              <span className="wfx-row-icon wfh-glyph">
                <Icon icon={STATE_ICON[state]} weight={state === "done" ? "fill" : "regular"} />
              </span>
              <span className="wfx-row-main">
                <span className="wfx-row-name">
                  <b>{nameOf(run)}</b>
                  <span className="wf-status" data-status={state}>
                    {stateLabel(state, s)}
                  </span>
                </span>
                <span className="wfx-row-trig">{subjectOf(run)}</span>
                <span className="wfx-row-foot">
                  <span>{triggerLabel(run, s)}</span>
                  <span>{when(run.startedAt)}</span>
                  <span>{durationLine(run, s)}</span>
                </span>
                {state === "failed" ? (
                  <span className="wfh-error">
                    {[failedAt, run.error].filter(Boolean).join(": ")}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </nav>
      {open ? (
        <section className="wfx-detail wfh-detail" aria-label={nameOf(open)}>
          <header className="wfx-head">
            <div className="wfx-title">
              <h2>{subjectOf(open) || nameOf(open)}</h2>
              <span className="wf-status" data-status={historyState(open)}>
                {stateLabel(historyState(open), s)}
              </span>
            </div>
            <div className="wfx-meta">
              <span>{nameOf(open)}</span>
              <span>{triggerLabel(open, s)}</span>
              <span>{when(open.startedAt)}</span>
              <span>{durationLine(open, s)}</span>
              {workflow && open.version !== workflow.version ? (
                <span>{fill(settings["strings.workflows.version"], { n: open.version })}</span>
              ) : null}
            </div>
            <div className="wfx-acts">
              {historyState(open) === "failed" && workflow && onRunAgain ? (
                <Btn sm primary disabled={busy} onClick={() => onRunAgain(open)}>
                  <Icon icon={ArrowClockwiseIcon} /> {s["strings.workflows.run_history.run_again"]}
                </Btn>
              ) : null}
              {open.threadId && onOpenThread ? (
                <Btn sm onClick={() => onOpenThread(open.threadId ?? "")}>
                  <Icon icon={EnvelopeSimpleIcon} />{" "}
                  {s["strings.workflows.run_history.open_thread"]}
                </Btn>
              ) : null}
              {workflow ? (
                <Btn sm onClick={() => onOpenWorkflow(workflow.id)}>
                  <Icon icon={ArrowSquareOutIcon} />{" "}
                  {s["strings.workflows.run_history.open_workflow"]}
                </Btn>
              ) : null}
              <Btn sm onClick={() => setOpenId(null)}>
                <Icon icon={XIcon} /> {s["strings.workflows.run_history.close"]}
              </Btn>
            </div>
          </header>
          {historyState(open) === "failed" ? (
            <div className="wfh-failure" role="alert">
              <Icon icon={WarningCircleIcon} />
              <span>
                {failedStepLine(open, s) ? <b>{failedStepLine(open, s)}</b> : null}
                {open.error ? <span>{open.error}</span> : null}
              </span>
            </div>
          ) : null}
          <h3 className="wfx-h">{s["strings.workflows.run_history.steps"]}</h3>
          {doc ? (
            <WorkflowFlow
              label={nameOf(open)}
              cards={flowModel(doc, fs, { groupName, run: open }).cards}
              fields={settings["workflows.page.step_details"]}
            />
          ) : (
            <RunSteps
              steps={open.steps.map((st) => ({
                index: st.index,
                name: st.name,
                status: st.status,
                detail: st.detail,
              }))}
            />
          )}
        </section>
      ) : (
        <p className="faint wfh-pick">{s["strings.workflows.run_history.pick"]}</p>
      )}
    </div>
  );
}
