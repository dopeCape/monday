// A Workflow drawn as what it is (ADR 0003): a readable vertical flow of
// cards. The trigger card says when it starts, each Step card carries its
// tool's glyph, a plain-language summary, its fields and the approval it
// runs under, and a condition card says what happens either way, with the
// Steps it guards set in under its "if yes" rail. The connectors are a thin
// secondary line; the cards hold the content. The same component draws the
// compact version on the composer's Workflow card, marks what an edit adds,
// changes and removes, and lays one Run's outcomes over the Steps.
//
// Everything arrives worded (the screen builds the cards from the document
// and the strings.* Settings); this module only draws.

import {
  ArchiveIcon,
  ArrowBendDownRightIcon,
  BellIcon,
  BrainIcon,
  CalendarBlankIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  CircleNotchIcon,
  ClockIcon,
  DiscordLogoIcon,
  EnvelopeSimpleIcon,
  FolderIcon,
  GitBranchIcon,
  GoogleDriveLogoIcon,
  HandIcon,
  HandPalmIcon,
  HourglassIcon,
  LightningIcon,
  LockSimpleIcon,
  NotePencilIcon,
  NotionLogoIcon,
  PaperPlaneTiltIcon,
  PlugsIcon,
  SealCheckIcon,
  SkipForwardIcon,
  SlackLogoIcon,
  StopCircleIcon,
  TagIcon,
  TimerIcon,
  WarningCircleIcon,
  WebhooksLogoIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cx } from "../format.ts";
import { Icon, type IconComponent } from "./icon.tsx";

/* ------------------------------ The model ------------------------------ */

/** A worded text with template holes: "New candidate: " then the hole "name from Extract". */
export type FlowText = ReadonlyArray<string | { hole: string }>;

/** One field a card lists under its summary: a message, a folder, the tools an agent Step may use. */
export interface FlowField {
  label: string;
  /** A text with holes, shown as one line (or a quote for instructions). */
  text?: FlowText | undefined;
  /** Short values drawn as chips: tags, tools, outputs. */
  chips?: readonly string[] | undefined;
  /** Long text, such as an agent Step's instructions, drawn as a quote. */
  quote?: boolean | undefined;
}

export type FlowTierKind = "ask" | "undo" | "read" | "standing";
export type FlowChangeKind = "added" | "changed" | "removed";
export type FlowRunStatus = "done" | "failed" | "waiting" | "skipped" | "running" | "not_reached";

export interface FlowCardModel {
  /** Stable across renders: "trigger", or the Step id. */
  key: string;
  tone: "trig" | "step" | "cond";
  /** A glyph name, mapped to Phosphor here: envelope, slack, drive, branch. */
  icon: string;
  /** Above the title: "When", "Step 2 · Post to Slack". */
  eyebrow: string;
  title: string;
  /** The Step in one plain sentence: "Posts to #hiring on Slack". */
  summary?: string | undefined;
  fields?: readonly FlowField[] | undefined;
  /** For the trigger: its conditions as chips, "From careers.example.com". */
  facts?: readonly string[] | undefined;
  tier?: { kind: FlowTierKind; label: string } | undefined;
  /** A Step's own failure policy, when it overrides the Workflow's. */
  note?: string | undefined;
  /** A condition's two ways: the yes rail's label and what happens otherwise. */
  branches?: { yes: string; no: string; noKind: "stop" | "skip" } | undefined;
  /** How many conditions this card sits under. */
  depth: number;
  /** What an edit does to this card. */
  change?: { kind: FlowChangeKind; label: string } | undefined;
  /** One Run's outcome at this card. */
  run?: { status: FlowRunStatus; label: string; detail?: string | undefined } | undefined;
}

/* ------------------------------ Glyphs ------------------------------ */

export const FLOW_GLYPHS: Readonly<Record<string, IconComponent>> = {
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
  lightning: LightningIcon,
};

export const flowGlyph = (name: string): IconComponent => FLOW_GLYPHS[name] ?? LightningIcon;

const TIER_GLYPH: Record<FlowTierKind, IconComponent> = {
  ask: HandPalmIcon,
  undo: ClockIcon,
  read: CircleDashedIcon,
  standing: SealCheckIcon,
};

const RUN_GLYPH: Record<FlowRunStatus, IconComponent> = {
  done: CheckCircleIcon,
  failed: WarningCircleIcon,
  waiting: HourglassIcon,
  skipped: SkipForwardIcon,
  running: CircleNotchIcon,
  not_reached: CircleDashedIcon,
};

/* ------------------------------ Pieces ------------------------------ */

/** A text with its holes as small chips, so "{{steps.extract.name}}" reads as "name from Extract". */
export function FlowTextView({ text }: { text: FlowText }) {
  return (
    <>
      {text.map((part, i) =>
        typeof part === "string" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one text never reorder.
          <span key={i}>{part}</span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one text never reorder.
          <span key={i} className="wflow-hole">
            {part.hole}
          </span>
        ),
      )}
    </>
  );
}

export function FlowTier({ kind, label }: { kind: FlowTierKind; label: string }) {
  return (
    <span className="wflow-tier" data-tier={kind}>
      <Icon icon={TIER_GLYPH[kind]} />
      {label}
    </span>
  );
}

function Fields({ fields }: { fields: readonly FlowField[] }) {
  return (
    <dl className="wflow-fields">
      {fields.map((f) => (
        <div key={f.label} className={cx(f.quote && "quote")}>
          <dt>{f.label}</dt>
          <dd>
            {f.chips ? (
              <span className="wflow-chips">
                {f.chips.map((c) => (
                  <span key={c} className="wflow-chip">
                    {c}
                  </span>
                ))}
              </span>
            ) : f.text ? (
              <FlowTextView text={f.text} />
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------ The flow ------------------------------ */

export interface WorkflowFlowProps {
  cards: readonly FlowCardModel[];
  /** The composer's card: smaller, the summary on the title line, no fields. */
  compact?: boolean | undefined;
  /** Whether Step cards list their fields (the Setting workflows.page.step_details). */
  fields?: boolean | undefined;
  /** Something under the last card, such as the removed Steps of an edit. */
  footer?: ReactNode | undefined;
  /** Paused or locked: the flow reads faded, nothing about it changes. */
  dim?: boolean | undefined;
  className?: string | undefined;
  label?: string | undefined;
}

export function WorkflowFlow({
  cards,
  compact,
  fields = true,
  footer,
  dim,
  className,
  label,
}: WorkflowFlowProps) {
  return (
    <div className={cx("wflow", compact && "compact", dim && "dim", className)}>
      <ol className="wflow-list" aria-label={label}>
        {cards.map((c, i) => {
          const next = cards[i + 1];
          const last = !next;
          return (
            <li
              key={c.key}
              className={cx("wflow-node", c.tone, last && "last")}
              data-key={c.key}
              data-depth={Math.min(c.depth, 3)}
              data-change={c.change?.kind}
              data-run={c.run?.status}
            >
              <div className="wflow-rail" aria-hidden="true">
                <span className="wflow-dot">
                  <Icon icon={flowGlyph(c.icon)} />
                </span>
              </div>
              <div className="wflow-card">
                <div className="wflow-top">
                  <span className="wflow-eyebrow">{c.eyebrow}</span>
                  {c.change ? (
                    <span className="wflow-change" data-change={c.change.kind}>
                      {c.change.label}
                    </span>
                  ) : null}
                  {c.run ? (
                    <span className="wflow-run" data-run={c.run.status}>
                      <Icon
                        icon={RUN_GLYPH[c.run.status]}
                        weight={c.run.status === "done" ? "fill" : "regular"}
                      />
                      {c.run.label}
                    </span>
                  ) : c.tier ? (
                    <FlowTier kind={c.tier.kind} label={c.tier.label} />
                  ) : null}
                </div>
                <div className="wflow-title">
                  <b>{c.title}</b>
                  {compact && c.summary ? <span className="wflow-sum">{c.summary}</span> : null}
                </div>
                {!compact && c.summary ? <p className="wflow-summary">{c.summary}</p> : null}
                {c.facts?.length ? (
                  <div className="wflow-facts">
                    {c.facts.map((f) => (
                      <span key={f} className="wflow-chip">
                        {f}
                      </span>
                    ))}
                  </div>
                ) : null}
                {!compact && fields && c.fields?.length ? <Fields fields={c.fields} /> : null}
                {c.run?.detail ? <p className="wflow-run-detail">{c.run.detail}</p> : null}
                {!compact && c.note ? <p className="wflow-note">{c.note}</p> : null}
                {c.branches ? (
                  <div className="wflow-branches">
                    <span className="yes">
                      <Icon icon={ArrowBendDownRightIcon} />
                      {c.branches.yes}
                    </span>
                    <span className="no" data-kind={c.branches.noKind}>
                      <Icon
                        icon={c.branches.noKind === "stop" ? StopCircleIcon : SkipForwardIcon}
                      />
                      {c.branches.no}
                    </span>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {footer}
    </div>
  );
}

/* ------------------------------ Status ------------------------------ */

export type WorkflowStatusKind = "on" | "off" | "locked" | "failing" | "waiting";

const STATUS_GLYPH: Record<WorkflowStatusKind, IconComponent | null> = {
  on: null,
  off: null,
  locked: LockSimpleIcon,
  failing: WarningCircleIcon,
  waiting: HandPalmIcon,
};

/** A Workflow's state as a small pill: on, switched off, locked by the AI level, failing, waiting. */
export function WorkflowStatus({ kind, label }: { kind: WorkflowStatusKind; label: string }) {
  const glyph = STATUS_GLYPH[kind];
  return (
    <span className="wf-status" data-status={kind}>
      {glyph ? <Icon icon={glyph} /> : <span className="wf-status-dot" />}
      {label}
    </span>
  );
}

/** The last Runs as dots, oldest first: done, failed, waiting, running. */
export function RunDots({
  recent,
  label,
}: {
  recent: readonly ("done" | "failed" | "paused" | "running")[];
  label?: string | undefined;
}) {
  if (recent.length === 0) return null;
  return (
    <span className="wf-dots" role="img" aria-label={label}>
      {recent.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed window of outcomes, oldest first.
        <span key={i} className="wf-dot" data-status={r} />
      ))}
    </span>
  );
}
