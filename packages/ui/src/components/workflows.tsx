// The Workflows page pieces (design/js/screens/workflows.js): a Workflow card
// with its sentence, its chain and the enabled switch; the Run log rows; the
// approval card a paused Run shows; the Dry run preview; the Source view.
// Everything renders read-only from the document (ADR 0003): the change
// surface is the ask box, never an editor.
import type { FlowNodeText, RunView, ToolCall, ToolPreview } from "@monday/shared";
import {
  ArchiveIcon,
  BellIcon,
  BrainIcon,
  CalendarBlankIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  ClockIcon,
  CloudIcon,
  DiscordLogoIcon,
  EnvelopeSimpleIcon,
  FolderIcon,
  GitBranchIcon,
  GoogleDriveLogoIcon,
  HandIcon,
  HourglassIcon,
  NotePencilIcon,
  NotionLogoIcon,
  PaperPlaneTiltIcon,
  PlugsIcon,
  SlackLogoIcon,
  TagIcon,
  TerminalWindowIcon,
  TimerIcon,
  WarningCircleIcon,
  WebhooksLogoIcon,
} from "@phosphor-icons/react";
import type { CSSProperties, ReactNode } from "react";
import { cx } from "../format.ts";
import { ToolCard } from "./agent.tsx";
import { FlowChain, type FlowNodeData } from "./flow-chain.tsx";
import { Icon, type IconComponent } from "./icon.tsx";
import { Btn, Switch, Tag } from "./primitives.tsx";
import { SideCard } from "./routing.tsx";

/* ------------------------------ Icons for the chain ------------------------------ */

const FLOW_ICONS: Record<string, IconComponent> = {
  envelope: EnvelopeSimpleIcon,
  calendar: CalendarBlankIcon,
  hand: HandIcon,
  tag: TagIcon,
  folder: FolderIcon,
  archive: ArchiveIcon,
  clock: ClockIcon,
  note: NotePencilIcon,
  send: PaperPlaneTiltIcon,
  bell: BellIcon,
  timer: TimerIcon,
  branch: GitBranchIcon,
  slack: SlackLogoIcon,
  notion: NotionLogoIcon,
  drive: GoogleDriveLogoIcon,
  discord: DiscordLogoIcon,
  webhook: WebhooksLogoIcon,
  plug: PlugsIcon,
  brain: BrainIcon,
};

/** The chain's nodes as the schema describes them, with their Phosphor icons. */
export function flowNodesOf(nodes: readonly FlowNodeText[]): FlowNodeData[] {
  return nodes.map((n) => ({
    kind: n.kind,
    icon: FLOW_ICONS[n.icon] ?? BrainIcon,
    label: n.label,
    detail: n.detail,
  }));
}

/* ------------------------------ WorkflowCard ------------------------------ */

export interface WorkflowCardProps {
  name: string;
  /** The sentence the user asked for. */
  sentence: string;
  nodes: readonly FlowNodeData[];
  enabled: boolean;
  placement: "server" | "local";
  /** "Runs on your server" or "Runs here via Claude Code", already worded. */
  placementLabel: string;
  /** "3 today", when there were Runs today. */
  todayLabel?: string | undefined;
  /** "2 waiting", when Runs wait for an approval. */
  waitingLabel?: string | undefined;
  pausedLabel?: string | undefined;
  /** "Last run 9 min ago", already worded. */
  lastRunLabel: string;
  selected?: boolean | undefined;
  onSelect?: (() => void) | undefined;
  onToggle?: ((enabled: boolean) => void) | undefined;
  enableLabel?: string | undefined;
  /** A change is on its way to the Server: the switch waits for it. */
  busy?: boolean | undefined;
  className?: string | undefined;
}

export function WorkflowCard({
  name,
  sentence,
  nodes,
  enabled,
  placement,
  placementLabel,
  todayLabel,
  waitingLabel,
  pausedLabel,
  lastRunLabel,
  selected,
  onSelect,
  onToggle,
  enableLabel,
  busy,
  className,
}: WorkflowCardProps) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the switch inside is the control; the card only selects.
    <div
      className={cx("wf-card", selected && "on", className)}
      data-selected={selected ? "true" : undefined}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) onSelect?.();
      }}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the card is a selectable row.
      tabIndex={0}
    >
      <div className="wf-top">
        <b>{name}</b>
        {todayLabel ? <Tag>{todayLabel}</Tag> : null}
        {waitingLabel ? <Tag kind="warn">{waitingLabel}</Tag> : null}
        {!enabled && pausedLabel ? <Tag>{pausedLabel}</Tag> : null}
        <span className="where">
          <Icon icon={placement === "server" ? CloudIcon : TerminalWindowIcon} /> {placementLabel}
        </span>
      </div>
      {sentence ? <p className="wf-desc">{sentence}</p> : null}
      <FlowChain nodes={nodes} />
      <div className="wf-foot">
        <span>{lastRunLabel}</span>
        <Switch
          on={enabled}
          label={enableLabel ?? name}
          disabled={busy}
          onChange={(next) => onToggle?.(next)}
        />
      </div>
    </div>
  );
}

/* ------------------------------ RunLog ------------------------------ */

export interface RunLogItem {
  id: string;
  status: RunView["status"];
  /** The Thread's subject, or what started the Run. */
  title: string;
  /** The last Step's line, or where it waits. */
  detail: string;
  /** "9 min ago", already worded. */
  when: string;
  versionLabel?: string | undefined;
}

export interface RunLogProps {
  runs: readonly RunLogItem[];
  emptyLabel: string;
  selectedId?: string | null | undefined;
  onSelect?: ((id: string) => void) | undefined;
  className?: string | undefined;
}

const RUN_ICON: Record<RunView["status"], IconComponent> = {
  done: CheckCircleIcon,
  failed: WarningCircleIcon,
  paused: HourglassIcon,
  running: CircleNotchIcon,
  queued: ClockIcon,
};

const EMPTY_STYLE: CSSProperties = { fontSize: "var(--fs-sm)", margin: "8px 0 0" };

export function RunLog({ runs, emptyLabel, selectedId, onSelect, className }: RunLogProps) {
  if (runs.length === 0) {
    return (
      <p className={cx("faint", className)} style={EMPTY_STYLE}>
        {emptyLabel}
      </p>
    );
  }
  return (
    <div className={cx("runlog", className)}>
      {runs.map((r) => (
        <button
          type="button"
          key={r.id}
          className={cx("r", r.status, r.id === selectedId && "on")}
          data-status={r.status}
          onClick={() => onSelect?.(r.id)}
          style={{ textAlign: "left", width: "100%" }}
        >
          <Icon icon={RUN_ICON[r.status]} weight={r.status === "done" ? "fill" : "regular"} />
          <div>
            {r.title}
            <span>
              {r.detail}
              {r.versionLabel ? ` · ${r.versionLabel}` : ""}
            </span>
          </div>
          <span className="t">{r.when}</span>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------ RunSteps ------------------------------ */

export interface RunStepItem {
  index: number;
  name: string;
  status: "running" | "done" | "failed" | "waiting" | "skipped";
  detail: string;
}

export interface RunStepsProps {
  steps: readonly RunStepItem[];
  className?: string | undefined;
}

const STEP_ICON: Record<RunStepItem["status"], IconComponent> = {
  done: CheckCircleIcon,
  failed: WarningCircleIcon,
  waiting: HourglassIcon,
  running: CircleNotchIcon,
  skipped: ClockIcon,
};

/** One Run's Steps with their outcomes, in order. */
export function RunSteps({ steps, className }: RunStepsProps) {
  return (
    <div className={cx("runlog run-steps", className)}>
      {steps.map((s) => (
        <div key={s.index} className={cx("r", s.status)} data-status={s.status}>
          <Icon icon={STEP_ICON[s.status]} weight={s.status === "done" ? "fill" : "regular"} />
          <div>
            {s.name}
            <span>{s.detail}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ RunApprovalCard ------------------------------ */

export interface RunApprovalCardProps {
  /** The waiting Tool call, as the composer shows it. */
  call: ToolCall;
  preview: ToolPreview | null;
  /** The rendered preview, in the app's language; a text preview renders as a paragraph. */
  previewNode?: ReactNode | undefined;
  approveLabel: string;
  standingLabel: string;
  declineLabel: string;
  onDecide: (decision: "approved" | "declined", standing: boolean) => void;
  busy?: boolean | undefined;
  className?: string | undefined;
}

const PRE_STYLE: CSSProperties = { whiteSpace: "pre-wrap", margin: 0, font: "inherit" };

/** The approval a paused Run waits for: the Step's payload and the three answers. */
export function RunApprovalCard({
  call,
  preview,
  previewNode,
  approveLabel,
  standingLabel,
  declineLabel,
  onDecide,
  busy,
  className,
}: RunApprovalCardProps) {
  const node =
    previewNode ??
    (preview?.kind === "text" ? (
      <pre style={PRE_STYLE}>{preview.text}</pre>
    ) : preview?.kind === "send" ? (
      <pre
        style={PRE_STYLE}
      >{`${preview.to.map((p) => p.email).join(", ")}: ${preview.subject}\n${preview.text}`}</pre>
    ) : null);
  return (
    <ToolCard
      call={call}
      preview={node}
      actions={[approveLabel, standingLabel, declineLabel]}
      onAction={(action) => {
        if (busy) return;
        if (action === approveLabel) onDecide("approved", false);
        else if (action === standingLabel) onDecide("approved", true);
        else onDecide("declined", false);
      }}
      className={cx("run-approval", className)}
    />
  );
}

/* ------------------------------ DryRunCard ------------------------------ */

export interface DryRunThreadItem {
  threadId: string;
  subject: string;
  from: string;
  steps: Array<{ name: string; status: string; detail: string }>;
  /** What the judge said about this Thread, worded by the screen (slice 27): "the message is a complaint: 92%". */
  judged?: readonly string[] | undefined;
}

export interface DryRunCardProps {
  title: string;
  note: string;
  threads: readonly DryRunThreadItem[];
  emptyLabel: string;
  closeLabel: string;
  /** Under a Thread with no Steps: the judged trigger turned it down. */
  notStartedLabel?: string | undefined;
  onClose: () => void;
  className?: string | undefined;
}

const DRY_STEP_STYLE: CSSProperties = { fontSize: "var(--fs-xs)", color: "var(--fg-faint)" };

/** What a Dry run would have done, Thread by Thread; nothing was applied. */
export function DryRunCard({
  title,
  note,
  threads,
  emptyLabel,
  closeLabel,
  notStartedLabel,
  onClose,
  className,
}: DryRunCardProps) {
  return (
    <SideCard
      title={title}
      className={cx("dry-run", className)}
      action={
        <Btn sm onClick={onClose}>
          {closeLabel}
        </Btn>
      }
    >
      <p className="faint" style={EMPTY_STYLE}>
        {threads.length === 0 ? emptyLabel : note}
      </p>
      <div className="runlog">
        {threads.map((t) => (
          <div key={t.threadId || t.subject} className="r" data-thread={t.threadId}>
            <div>
              {t.subject || t.from || "(no thread)"}
              {t.judged?.map((line) => (
                <span key={line} style={DRY_STEP_STYLE} data-judged="true">
                  {line}
                </span>
              ))}
              {t.steps.length === 0 && t.judged?.length && notStartedLabel ? (
                <span style={DRY_STEP_STYLE} data-status="not_started">
                  {notStartedLabel}
                </span>
              ) : null}
              {t.steps.map((s) => (
                <span key={s.name} style={DRY_STEP_STYLE} data-status={s.status}>
                  {s.name}: {s.detail || s.status.replaceAll("_", " ")}
                </span>
              ))}
            </div>
            <span className="t">{t.from}</span>
          </div>
        ))}
      </div>
    </SideCard>
  );
}

/* ------------------------------ SourceView ------------------------------ */

export interface SourceViewProps {
  document: unknown;
  className?: string | undefined;
}

const SOURCE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-xs)",
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  margin: "8px 0 0",
  maxHeight: 360,
  overflow: "auto",
};

/** The document as JSON: the user can always read the source (ADR 0003). */
export function SourceView({ document, className }: SourceViewProps) {
  return (
    <pre className={cx("source", className)} style={SOURCE_STYLE}>
      {JSON.stringify(document, null, 2)}
    </pre>
  );
}
