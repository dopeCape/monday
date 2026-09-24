// The tool UIs (Mosaic's tool-fallback, agent-activity and tool-group), in
// monday's language. Every tool call renders from its ToolCall: a read-only
// step is a compact row inside the turn's steps line, which folds once the
// answer starts; a card that changes mail, sends, schedules or changes a
// Setting stays a full card with its preview, Approve or Apply and Cancel
// while it waits, and Undo once it applied. The tiers and approvals are the
// Server's (ADR 0002): the buttons call the Session's approve, decline and
// Undo, never Assistant UI's tool results.
//
// Registry: each tool monday knows is registered by name; anything else
// (an extension's tool, a Local runtime's own tool in Developer mode) takes
// the fallback, which picks row or card by tier the same way.

import {
  type GroupByContext,
  type PartState,
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
  useAssistantToolUI,
  useAuiState,
} from "@assistant-ui/react";
import type { ToolCall, ToolPreview, WorkflowPreview } from "@monday/shared";
import { diffWorkflow } from "@monday/shared";
import {
  AgentSteps,
  formatListTime,
  formatSpan,
  type IconComponent,
  ToolCard,
  WorkflowFlow,
} from "@monday/ui";
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  ArrowsLeftRightIcon,
  CalendarCheckIcon,
  CalendarDotsIcon,
  CalendarIcon,
  CalendarPlusIcon,
  CalendarXIcon,
  ClockIcon,
  EnvelopeOpenIcon,
  FlowArrowIcon,
  FolderSimpleIcon,
  FolderSimplePlusIcon,
  FunnelIcon,
  GearSixIcon,
  HourglassIcon,
  LayoutIcon,
  LightningIcon,
  ListBulletsIcon,
  MagnifyingGlassIcon,
  PaperPlaneTiltIcon,
  PencilSimpleIcon,
  RowsIcon,
  ShareFatIcon,
  TagIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import { CalendarDraftPreview } from "../../calendar/DraftCard.tsx";
import { diffLine, flowModel } from "../../screens/workflows/flow.ts";
import { type ComposerStrings, fill } from "../composerStrings.ts";
import { cardActions, statusLabel, toolTitle } from "../transcript.ts";
import { useComposerEnv, useElapsedSeconds, workingLabel } from "./context.tsx";
import { ERROR_TOOL, isStep, type ToolArtifact } from "./messages.ts";

/* ------------------------------ Previews ------------------------------ */

const LINK_LABELS: Record<string, string> = {
  "google-meet": "Google Meet",
  teams: "Microsoft Teams",
  jitsi: "Jitsi",
  custom: "your custom URL",
};

/** A link kind reads as its product name; a URL reads as its host. */
function linkLabel(link: string): string {
  if (LINK_LABELS[link]) return LINK_LABELS[link] as string;
  try {
    return new URL(link).host;
  } catch {
    return link;
  }
}

/** Which Provider a card's link kind implies, for the "goes out from" line. */
function sourceOf(e: { link: string | null }): string {
  if (e.link === "google-meet" || (e.link ?? "").includes("meet.google.com")) return "google";
  if (e.link === "teams" || (e.link ?? "").includes("teams.microsoft.com")) return "graph";
  return "calendar";
}

/** The preview in the app's own language: thread rows, the message, the Setting line, the event. */
export function PreviewView({
  preview,
  strings,
  now,
}: {
  preview: ToolPreview;
  strings: ComposerStrings;
  now: Date;
}): ReactNode {
  switch (preview.kind) {
    case "threads": {
      const more = preview.count - preview.threads.length;
      return (
        <div className="agent-preview">
          <div className="count">
            {fill(strings["strings.agent.preview_threads"], { n: preview.count })}
          </div>
          <div className="results">
            {preview.threads.map((t) => (
              <div key={t.id} className="r">
                <b>{t.subject}</b>
                <span>{t.from}</span>
                <span className="t">{formatListTime(t.lastActivity, now)}</span>
              </div>
            ))}
          </div>
          {more > 0 ? (
            <div className="more">{fill(strings["strings.agent.preview_more"], { n: more })}</div>
          ) : null}
        </div>
      );
    }
    case "send":
      return (
        <div className="agent-preview">
          <div className="count">
            {fill(strings["strings.agent.preview_send"], {
              to: preview.to.map((p) => p.name || p.email).join(", "),
              subject: preview.subject,
            })}
          </div>
          <div className="body">{preview.text}</div>
        </div>
      );
    case "setting":
      return (
        <div className="agent-preview">
          {fill(strings["strings.agent.preview_setting"], {
            key: preview.key,
            from: JSON.stringify(preview.from),
            to: JSON.stringify(preview.to),
          })}
        </div>
      );
    case "event": {
      const e = preview.event;
      const verb =
        e.action === "rsvp"
          ? fill(strings["strings.agent.preview_event.rsvp"], { response: e.response ?? "" })
          : strings[`strings.agent.preview_event.${e.action}`];
      const source = { google: "Google", graph: "Microsoft", caldav: "CalDAV", jmap: "Fastmail" };
      return (
        <div className="agent-preview agent-event">
          <div className="count">{verb}</div>
          <div className="ev-title">{e.title}</div>
          <div className="ev-when">{formatSpan(e.start, e.end, e.allDay)}</div>
          {e.attendees.length > 0 ? (
            <div className="ev-who">{e.attendees.map((p) => p.name || p.email).join(", ")}</div>
          ) : null}
          {e.link ? (
            <div className="ev-link">
              {fill(strings["strings.agent.preview_event.link"], { link: linkLabel(e.link) })}
            </div>
          ) : null}
          {e.conflicts.length > 0 ? (
            <div className="ev-conflict">
              {fill(strings["strings.agent.preview_event.conflicts"], {
                titles: e.conflicts.join(", "),
              })}
            </div>
          ) : null}
          {e.invitesBy === "provider" ? (
            <div className="more">
              {fill(strings["strings.agent.preview_event.by_provider"], {
                source: (source as Record<string, string>)[sourceOf(e)] ?? "calendar",
              })}
            </div>
          ) : e.invitesBy === "monday" ? (
            <div className="more">{strings["strings.agent.preview_event.by_monday"]}</div>
          ) : null}
        </div>
      );
    }
    case "calendar-draft":
      return <CalendarDraftPreview draft={preview.draft} />;
    case "groups":
      return (
        <div className="agent-preview agent-groups">
          <div className="count">
            {fill(strings["strings.agent.preview_groups.title"], { n: preview.groups.length })}
          </div>
          <ul className="group-proposals">
            {preview.groups.map((g) => (
              <li key={g.name} className="group-proposal">
                <FolderSimplePlusIcon aria-hidden="true" />
                <div>
                  <b>{g.name}</b>
                  <span>{g.sentence}</span>
                </div>
                <span className="moves" data-moves={g.moves}>
                  {g.moves > 0
                    ? fill(strings["strings.agent.preview_groups.moves"], { n: g.moves })
                    : strings["strings.agent.preview_groups.none"]}
                </span>
              </li>
            ))}
          </ul>
          <div className="more">
            {fill(strings["strings.agent.preview_groups.note"], { n: preview.considered })}
          </div>
        </div>
      );
    case "workflow":
      return <WorkflowPreviewView preview={preview} strings={strings} />;
    default:
      return <div className="agent-preview">{preview.text}</div>;
  }
}

/**
 * The Workflow card: what the Workflow will be, drawn as the same flow the
 * Workflows page shows, compact; for an edit, which Steps are new, changed
 * or taken out. Apply, Undo and Approve are the card's own buttons (ADR 0002).
 */
function WorkflowPreviewView({
  preview,
  strings,
}: {
  preview: WorkflowPreview;
  strings: ComposerStrings;
}) {
  const w = preview.workflow;
  const diff = preview.previous ? diffWorkflow(preview.previous, w) : null;
  const names = preview.groupNames ?? {};
  const model = flowModel(w, strings, { diff, groupName: (id) => names[id] ?? id });
  const lead = fill(strings[`strings.agent.preview_workflow.${preview.action}`], {
    name: w.name,
    version: preview.version ?? "",
  });
  return (
    <div className="agent-preview agent-workflow" data-action={preview.action}>
      <div className="count">{lead}</div>
      {diff ? (
        <div className="wf-diff" data-changed={diff.changed ? "true" : "false"}>
          <span>{diffLine(diff, strings)}</span>
          {diff.renamed && preview.previous ? (
            <span>
              {fill(strings["strings.agent.preview_workflow.renamed"], {
                name: preview.previous.name,
              })}
            </span>
          ) : null}
          {diff.trigger === "changed" ? (
            <span>{strings["strings.agent.preview_workflow.trigger"]}</span>
          ) : null}
        </div>
      ) : null}
      <WorkflowFlow
        compact
        cards={model.cards}
        label={w.name}
        footer={
          model.removed.length ? (
            <WorkflowFlow compact cards={model.removed} className="wflow-removed" />
          ) : undefined
        }
      />
      {preview.note ? <div className="more wf-note">{preview.note}</div> : null}
    </div>
  );
}

/* ------------------------------ Cards ------------------------------ */

/** A card's title: the tool as the mock words it; a Developer mode tool carries its warning title. */
export function cardTitle(call: ToolCall, strings: ComposerStrings): string {
  return call.builtin
    ? fill(strings["strings.agent.builtin_tool"], { tool: call.tool })
    : toolTitle(call);
}

/**
 * What each tool does, as a glyph before its title (Assistant UI's tool
 * timeline: a verb, an icon, a chip). A tool not listed has none.
 */
export const TOOL_ICONS: Readonly<Record<string, IconComponent>> = {
  search_threads: MagnifyingGlassIcon,
  read_thread: EnvelopeOpenIcon,
  list_groups_and_sections: ListBulletsIcon,
  list_events: CalendarIcon,
  list_workflows: FlowArrowIcon,
  list_workflow_runs: FlowArrowIcon,
  create_workflow: FlowArrowIcon,
  update_workflow: FlowArrowIcon,
  enable_workflow: FlowArrowIcon,
  adopt_workflow: FlowArrowIcon,
  archive_threads: ArchiveIcon,
  snooze_threads: ClockIcon,
  tag_threads: TagIcon,
  move_threads: FolderSimpleIcon,
  trash_threads: TrashIcon,
  organize_existing: FunnelIcon,
  draft_message: PencilSimpleIcon,
  send_draft: PaperPlaneTiltIcon,
  forward_thread: ShareFatIcon,
  schedule_event: CalendarPlusIcon,
  update_event: CalendarIcon,
  rsvp: CalendarCheckIcon,
  delete_event: CalendarXIcon,
  move_event: ArrowsLeftRightIcon,
  list_calendars: CalendarIcon,
  search_events: MagnifyingGlassIcon,
  find_free_time: HourglassIcon,
  propose_calendar_draft: CalendarDotsIcon,
  get_calendar_draft: CalendarDotsIcon,
  change_setting: GearSixIcon,
  change_layout: LayoutIcon,
  create_section: RowsIcon,
  update_section: RowsIcon,
  delete_section: RowsIcon,
  create_group: FolderSimplePlusIcon,
  propose_groups: FolderSimplePlusIcon,
  update_group: FolderSimpleIcon,
  create_action: LightningIcon,
  update_action: LightningIcon,
  delete_action: LightningIcon,
  undo: ArrowCounterClockwiseIcon,
};

export const toolIcon = (tool: string): IconComponent | undefined => TOOL_ICONS[tool];

/**
 * The line an approval card carries while it asks (Assistant UI's approval
 * card subtitle): an always-ask call waits for Approve, a reversible one
 * applies with Undo. Nothing for a call that does not ask.
 */
export function approvalNote(call: ToolCall, strings: ComposerStrings): string | undefined {
  if (call.status !== "waiting") return undefined;
  return call.tier === "always-ask"
    ? strings["strings.agent.asks.always"]
    : strings["strings.agent.asks.reversible"];
}

const artifactOf = (props: { artifact?: unknown }): ToolArtifact | null => {
  const a = props.artifact as ToolArtifact | undefined;
  return a && typeof a === "object" && "call" in a ? a : null;
};

/** One tool call as a monday card: a compact row for a step, a full card otherwise. */
function MondayTool(props: ToolCallMessagePartProps) {
  const { strings, now, actions } = useComposerEnv();
  const running = useAuiState((s) => s.thread.isRunning);
  const artifact = artifactOf(props);
  if (!artifact) return null;
  const { call, preview } = artifact;
  // A call still running once the turn is not was stopped: no spinner, and it says so.
  const stopped = call.status === "running" && !running;
  const shown: ToolCall = stopped ? { ...call, status: "failed" } : call;
  // A step that read something has no result line to show: the check says it is done.
  const step = isStep(call);
  const onAction = (action: string) => {
    if (action === strings["strings.agent.approve"] || action === strings["strings.agent.apply"]) {
      actions.approve(call.id);
    } else if (action === strings["strings.agent.decline"]) {
      actions.decline(call.id);
    } else if (action === strings["strings.agent.undo"]) {
      actions.undo(call.id);
    }
  };
  return (
    <ToolCard
      call={shown}
      className={step ? (stopped ? "step stopped" : "step") : stopped ? "stopped" : undefined}
      icon={toolIcon(call.tool)}
      note={approvalNote(call, strings)}
      title={cardTitle(call, strings)}
      statusLabel={
        stopped
          ? strings["strings.agent.stopped"]
          : step && call.status === "done" && !call.result
            ? ""
            : statusLabel(call, strings)
      }
      preview={preview ? <PreviewView preview={preview} strings={strings} now={now} /> : undefined}
      actions={stopped ? [] : cardActions(call, strings)}
      onAction={onAction}
    />
  );
}

/** A turn that failed on the Server or in the CLI: the failure and Retry, which sends the same text. */
function ErrorTool(props: ToolCallMessagePartProps) {
  const { strings, actions } = useComposerEnv();
  const artifact = artifactOf(props);
  if (!artifact) return null;
  return (
    <ToolCard
      call={artifact.call}
      className="agent-failure"
      title={strings["strings.agent.failed"]}
      statusLabel={strings["strings.agent.failed"]}
      actions={[strings["strings.agent.retry"]]}
      onAction={() => actions.retry()}
    />
  );
}

/** Tools monday ships, by name. The Server's catalog is the source; a new tool falls back until listed. */
export const TOOL_UIS: Readonly<Record<string, ToolCallMessagePartComponent>> = {
  // Read: steps.
  search_threads: MondayTool,
  read_thread: MondayTool,
  list_groups_and_sections: MondayTool,
  list_events: MondayTool,
  list_workflows: MondayTool,
  list_workflow_runs: MondayTool,
  // Change mail: reversible cards with a preview above the threshold and Undo.
  archive_threads: MondayTool,
  snooze_threads: MondayTool,
  tag_threads: MondayTool,
  move_threads: MondayTool,
  trash_threads: MondayTool,
  organize_existing: MondayTool,
  // Leave the mailbox: always-ask cards with the exact payload.
  draft_message: MondayTool,
  send_draft: MondayTool,
  forward_thread: MondayTool,
  // Calendar: the event card.
  schedule_event: MondayTool,
  update_event: MondayTool,
  rsvp: MondayTool,
  delete_event: MondayTool,
  move_event: MondayTool,
  list_calendars: MondayTool,
  search_events: MondayTool,
  find_free_time: MondayTool,
  get_calendar_draft: MondayTool,
  // A calendar draft: a card with the diff and Apply, never a folded step.
  propose_calendar_draft: MondayTool,
  // Workflows: the card draws the flow, and for an edit what changes.
  create_workflow: MondayTool,
  update_workflow: MondayTool,
  enable_workflow: MondayTool,
  adopt_workflow: MondayTool,
  // The app itself.
  change_setting: MondayTool,
  change_layout: MondayTool,
  create_section: MondayTool,
  update_section: MondayTool,
  delete_section: MondayTool,
  create_group: MondayTool,
  update_group: MondayTool,
  create_action: MondayTool,
  update_action: MondayTool,
  delete_action: MondayTool,
  undo: MondayTool,
  // Onboarding: the Groups proposal as its own rows, the keymap as a Setting line.
  propose_groups: MondayTool,
  set_keymap: MondayTool,
  // A failed turn.
  [ERROR_TOOL]: ErrorTool,
};

/** Anything not in the registry: an extension's tool, a Local runtime's own tool. */
export const ToolFallback: ToolCallMessagePartComponent = MondayTool;

function ToolUI({ name, render }: { name: string; render: ToolCallMessagePartComponent }) {
  useAssistantToolUI({ toolName: name, render });
  return null;
}

/** Registers every tool UI with Assistant UI; mounted once inside the runtime provider. */
export function MondayToolUIs() {
  return (
    <>
      {Object.entries(TOOL_UIS).map(([name, render]) => (
        <ToolUI key={name} name={name} render={render} />
      ))}
    </>
  );
}

/* ------------------------------ Steps ------------------------------ */

type StepsKey = "group-steps";
const STEPS: readonly StepsKey[] = ["group-steps"];

/**
 * Groups adjacent steps of a turn into one folding line. Module scope, so
 * GroupedParts keeps its memo across renders.
 */
export const groupSteps = (
  part: PartState,
  _context: GroupByContext,
): readonly StepsKey[] | null => {
  if (part.type !== "tool-call") return null;
  const artifact = artifactOf(part as { artifact?: unknown });
  return artifact && isStep(artifact.call) ? STEPS : null;
};

/** "Searched mail, Read thread (2)": each distinct title once, with a count when repeated. */
export function stepsSummary(calls: readonly ToolCall[], strings: ComposerStrings): string {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const title = cardTitle(call, strings);
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return [...counts].map(([title, n]) => (n > 1 ? `${title} (${n})` : title)).join(", ");
}

type PartLike = { type: string; text?: string; artifact?: unknown };

/**
 * The steps line (Mosaic's AgentTimelineGroup): open while the turn works,
 * folded to a summary the moment answer text follows it, when
 * ai.composer.fold_activity is on. A turn loaded from History starts folded.
 */
export function StepsGroup({
  indices,
  children,
}: {
  indices: readonly number[];
  children: ReactNode;
}) {
  const { strings, runStartedAt } = useComposerEnv();
  const parts = useAuiState((s) => s.message.parts) as readonly PartLike[];
  const running = useAuiState((s) => s.message.status?.type === "running");
  const last = indices.length ? Math.max(...indices) : -1;
  const answered = parts.some(
    (p, i) => i > last && p.type === "text" && (p.text ?? "").trim().length > 0,
  );
  const fold = strings["ai.composer.fold_activity"];
  const [open, setOpen] = useState(!(fold && answered));
  const [wasAnswered, setWasAnswered] = useState(answered);
  if (answered !== wasAnswered) {
    setWasAnswered(answered);
    if (fold && answered) setOpen(false);
  }
  const calls = indices.flatMap((i) => {
    const artifact = artifactOf(parts[i] ?? {});
    return artifact ? [artifact.call] : [];
  });
  const active = running && !answered;
  // Only the active line ticks: a folded group reads as settled.
  const seconds = useElapsedSeconds(active ? runStartedAt : null);
  const n = calls.length;
  return (
    <AgentSteps
      open={open}
      onToggle={() => setOpen((o) => !o)}
      active={active}
      label={active ? workingLabel(strings, seconds) : stepsSummary(calls, strings)}
      count={
        n === 1
          ? strings["strings.agent.steps_one"]
          : fill(strings["strings.agent.steps_many"], { n })
      }
    >
      {children}
    </AgentSteps>
  );
}
