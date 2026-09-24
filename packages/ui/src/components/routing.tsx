// The Routing page pieces (design/js/screens/routing.js): the page head, a
// Group card with its rule and Sub-groups, the side cards, the ask box, the
// sample rows the Needs a decision queue and "Recently routed" share, and
// the re-run preview. Calm rules: one surface, no cards inside cards, color
// only for state.
import type { Predicate } from "@monday/shared";
import { CaretRightIcon, DotsThreeIcon, XIcon } from "@phosphor-icons/react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { cx } from "../format.ts";
import { Icon, type IconComponent } from "./icon.tsx";
import { Avatar, Btn, Mark, Tag } from "./primitives.tsx";

/* ------------------------------ PageHead ------------------------------ */

export interface PageHeadProps {
  title: string;
  subtitle?: string | undefined;
  /** The actions on the right: buttons. */
  children?: ReactNode | undefined;
  className?: string | undefined;
}

export function PageHead({ title, subtitle, children, className }: PageHeadProps) {
  return (
    <div className={cx("page-head", className)}>
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {children ? <div className="acts">{children}</div> : null}
    </div>
  );
}

/* ------------------------------ RuleText ------------------------------ */

export interface RuleTextProps {
  sentence: string;
  /** Header facts the rule always applies; their mentions in the sentence render as code. */
  predicate?: Predicate | undefined;
  className?: string | undefined;
}

/** The tokens a Predicate contributes, longest first, plus the "local@" prefix of each sender. */
function predicateTokens(p: Predicate | undefined): string[] {
  if (!p) return [];
  const out = new Set<string>();
  for (const s of p.senders ?? []) {
    out.add(s);
    const at = s.indexOf("@");
    if (at > 0) out.add(s.slice(0, at + 1));
  }
  for (const d of p.domains ?? []) out.add(d);
  for (const l of p.listIds ?? []) out.add(l);
  for (const s of p.subjectPatterns ?? []) if (!s.startsWith("/")) out.add(s);
  return [...out].filter((t) => t.length > 1).sort((a, b) => b.length - a.length);
}

/** The sentence with every Predicate mention in code, as the mock draws domains and addresses. */
export function RuleText({ sentence, predicate, className }: RuleTextProps) {
  const tokens = predicateTokens(predicate);
  const parts: ReactNode[] = [];
  let rest = sentence;
  let key = 0;
  while (rest.length > 0) {
    let best: { index: number; token: string } | null = null;
    const lower = rest.toLowerCase();
    for (const token of tokens) {
      const index = lower.indexOf(token.toLowerCase());
      if (index >= 0 && (best === null || index < best.index)) best = { index, token };
    }
    if (!best) {
      parts.push(rest);
      break;
    }
    if (best.index > 0) parts.push(rest.slice(0, best.index));
    parts.push(<code key={key++}>{rest.slice(best.index, best.index + best.token.length)}</code>);
    rest = rest.slice(best.index + best.token.length);
  }
  return (
    <div className={cx("rule", className)}>
      <div>{parts}</div>
    </div>
  );
}

/* ------------------------------ GroupCard ------------------------------ */

export interface SubgroupItem {
  id: string;
  name: string;
  /** The Sub-group's own sentence, shown under its name. */
  description?: string | undefined;
  /** Unread count; nothing shown at zero. */
  count?: number | undefined;
  icon?: IconComponent | undefined;
}

export interface GroupCardProps {
  id: string;
  name: string;
  /** "6 unread", already worded. */
  meta?: string | undefined;
  /** "94% confident", already worded; absent until something was scored. */
  confidence?: string | undefined;
  /** The rule sentence. */
  sentence: string;
  predicate?: Predicate | undefined;
  /** Shown in place of an empty sentence. */
  noRule?: string | undefined;
  subgroups?: readonly SubgroupItem[] | undefined;
  changeRuleLabel: string;
  onChangeRule?: ((id: string) => void) | undefined;
  onMore?: ((id: string) => void) | undefined;
  onOpenSubgroup?: ((id: string) => void) | undefined;
  className?: string | undefined;
}

export function GroupCard({
  id,
  name,
  meta,
  confidence,
  sentence,
  predicate,
  noRule,
  subgroups,
  changeRuleLabel,
  onChangeRule,
  onMore,
  onOpenSubgroup,
  className,
}: GroupCardProps) {
  return (
    <div className={cx("grp", className)} data-group={id}>
      <div className="grp-h">
        <span className="dot" />
        <b>{name}</b>
        {meta ? <span className="n">{meta}</span> : null}
        {confidence ? <Tag>{confidence}</Tag> : null}
        <div className="acts">
          <Btn sm onClick={() => onChangeRule?.(id)}>
            {changeRuleLabel}
          </Btn>
          <Btn sm icon aria-label="More" onClick={() => onMore?.(id)}>
            <Icon icon={DotsThreeIcon} />
          </Btn>
        </div>
      </div>
      {sentence ? (
        <RuleText sentence={sentence} predicate={predicate} />
      ) : noRule ? (
        <div className="rule">
          <div>{noRule}</div>
        </div>
      ) : null}
      {subgroups?.length ? (
        <div className="sub-list">
          {subgroups.map((s) => (
            <div key={s.id} className="subg" data-group={s.id}>
              {s.icon ? <Icon icon={s.icon} /> : <i className="ph" aria-hidden="true" />}
              <div>
                {s.name}
                {s.description ? <span className="d">{s.description}</span> : null}
              </div>
              <div className="r">
                {s.count ? <Tag>{s.count}</Tag> : null}
                <Btn sm icon aria-label={s.name} onClick={() => onOpenSubgroup?.(s.id)}>
                  <Icon icon={CaretRightIcon} />
                </Btn>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ SideCard ------------------------------ */

export interface SideCardProps {
  title: string;
  /** A count beside the title, such as the size of Needs a decision. */
  count?: number | undefined;
  /** A button on the right of the title. */
  action?: ReactNode | undefined;
  children?: ReactNode | undefined;
  className?: string | undefined;
}

export function SideCard({ title, count, action, children, className }: SideCardProps) {
  return (
    <div className={cx("side-card", className)}>
      <h3>
        {title}
        {count ? <Tag>{count}</Tag> : null}
        {action}
      </h3>
      {children}
    </div>
  );
}

/* ------------------------------ AskBox ------------------------------ */

export interface AskBoxProps {
  placeholder: string;
  help?: string | undefined;
  value?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
  onSubmit?: ((value: string) => void) | undefined;
  className?: string | undefined;
}

const HELP_STYLE: CSSProperties = { fontSize: "var(--fs-xs)", margin: "8px 0 0", lineHeight: 1.5 };

/** "Ask for a group": the sentence goes to the composer, where the Agent proposes a rule and shows what would move. */
export function AskBox({ placeholder, help, value, onChange, onSubmit, className }: AskBoxProps) {
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem("ask") as HTMLInputElement | null;
    onSubmit?.(input?.value ?? value ?? "");
  };
  return (
    <form className={className} onSubmit={submit}>
      <div className="ask">
        <Mark small />
        <input
          name="ask"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange?.(e.currentTarget.value)}
        />
      </div>
      {help ? (
        <p className="faint" style={HELP_STYLE}>
          {help}
        </p>
      ) : null}
    </form>
  );
}

/* ------------------------------ SampleRow ------------------------------ */

export interface SampleRowProps {
  /** Who the Thread is from, for the avatar. */
  name: string;
  subject: string;
  /** A tag on the right, such as the Group the Thread went to. */
  tag?: string | undefined;
  /** Buttons on the right instead of a tag. */
  actions?: ReactNode | undefined;
  color?: string | undefined;
  className?: string | undefined;
}

const TAG_STYLE: CSSProperties = { marginLeft: "auto", flex: "none" };

export function SampleRow({ name, subject, tag, actions, color, className }: SampleRowProps) {
  return (
    <div className={cx("sample", className)}>
      <Avatar name={name} color={color ?? "var(--fg-muted)"} />
      <span>{subject}</span>
      {tag ? (
        <span className="tag" style={TAG_STYLE}>
          {tag}
        </span>
      ) : null}
      {actions ? <div className="acts">{actions}</div> : null}
    </div>
  );
}

/* ------------------------------ DecisionRow ------------------------------ */

export interface DecisionCandidateItem {
  id: string;
  label: string;
}

export interface DecisionRowProps {
  threadId: string;
  name: string;
  subject: string;
  /** The Groups the Thread could join, best first; at most two are shown as buttons. */
  candidates: readonly DecisionCandidateItem[];
  onPick: (threadId: string, groupId: string) => void;
  /** Leave the Thread out of every Group. */
  onLeave?: ((threadId: string) => void) | undefined;
  leaveLabel: string;
  className?: string | undefined;
}

/** One Thread in Needs a decision: its candidates as buttons, and an X to leave it out of every Group. */
export function DecisionRow({
  threadId,
  name,
  subject,
  candidates,
  onPick,
  onLeave,
  leaveLabel,
  className,
}: DecisionRowProps) {
  const shown = candidates.slice(0, 2);
  return (
    <SampleRow
      name={name}
      subject={subject}
      className={className}
      actions={
        <>
          {shown.map((c) => (
            <Btn key={c.id} sm onClick={() => onPick(threadId, c.id)}>
              {c.label}
            </Btn>
          ))}
          {onLeave ? (
            <Btn
              sm
              icon
              aria-label={leaveLabel}
              title={leaveLabel}
              onClick={() => onLeave(threadId)}
            >
              <Icon icon={XIcon} />
            </Btn>
          ) : null}
        </>
      }
    />
  );
}

/* ------------------------------ Preview ------------------------------ */

export interface PreviewMoveItem {
  threadId: string;
  name: string;
  subject: string;
  /** Where it would go, worded: a Group name, "Needs a decision", "No group". */
  target: string;
}

export interface PreviewCardProps {
  title: string;
  /** "3 of 50 threads would move", already worded. */
  summary: string;
  moves: readonly PreviewMoveItem[];
  emptyLabel: string;
  applyLabel: string;
  cancelLabel: string;
  onApply: () => void;
  onCancel: () => void;
  busy?: boolean | undefined;
  className?: string | undefined;
}

/** The re-run preview: what would move, and the two buttons that apply it or drop it. */
export function PreviewCard({
  title,
  summary,
  moves,
  emptyLabel,
  applyLabel,
  cancelLabel,
  onApply,
  onCancel,
  busy,
  className,
}: PreviewCardProps) {
  return (
    <SideCard
      title={title}
      className={cx("preview", className)}
      action={
        <span className="preview-acts">
          <Btn sm onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Btn>
          <Btn sm primary onClick={onApply} disabled={busy || moves.length === 0}>
            {applyLabel}
          </Btn>
        </span>
      }
    >
      <p className="faint" style={HELP_STYLE}>
        {moves.length === 0 ? emptyLabel : summary}
      </p>
      {moves.map((m) => (
        <SampleRow key={m.threadId} name={m.name} subject={m.subject} tag={m.target} />
      ))}
    </SideCard>
  );
}

/* ------------------------------ The Routing page, redone ------------------------------ */

export interface RuleGroupCardProps {
  id: string;
  name: string;
  icon?: IconComponent | undefined;
  /** "6 unread", "12 threads": already worded, in order. */
  stats: readonly string[];
  /** Mean Confidence 0..1, drawn as a small meter; null until something was scored. */
  confidence: number | null;
  /** "94% confident", already worded. */
  confidenceLabel?: string | undefined;
  ruleLabel: string;
  sentence: string;
  predicate?: Predicate | undefined;
  noRule?: string | undefined;
  /** The Predicate as worded chips: "Anyone at careers.example.com". */
  alwaysLabel: string;
  always: readonly string[];
  /** "Asks you below 70% sure", when the Group sets its own threshold. */
  threshold?: string | undefined;
  /** Set while the AI level keeps sorting paused: the rule is kept, and says so. */
  pausedLabel?: string | undefined;
  subgroups?: readonly SubgroupItem[] | undefined;
  /** "Learned from 3 of your corrections", with the Examples behind a toggle. */
  learned?:
    | { label: string; toggle: string; open: boolean; onToggle: () => void; body: ReactNode }
    | undefined;
  changeRuleLabel: string;
  onChangeRule?: ((id: string) => void) | undefined;
  openLabel: string;
  onOpen?: ((id: string) => void) | undefined;
  onOpenSubgroup?: ((id: string) => void) | undefined;
  /** The rule editor, when it is open on this Group. */
  children?: ReactNode | undefined;
  className?: string | undefined;
}

/** One Group as the Routing page shows it: who it is for in plain words, what always goes there, what it learned. */
export function RuleGroupCard({
  id,
  name,
  icon,
  stats,
  confidence,
  confidenceLabel,
  ruleLabel,
  sentence,
  predicate,
  noRule,
  alwaysLabel,
  always,
  threshold,
  pausedLabel,
  subgroups,
  learned,
  changeRuleLabel,
  onChangeRule,
  openLabel,
  onOpen,
  onOpenSubgroup,
  children,
  className,
}: RuleGroupCardProps) {
  const pct = confidence === null ? null : Math.round(Math.max(0, Math.min(1, confidence)) * 100);
  return (
    <article
      className={cx("rgrp", className)}
      data-group={id}
      data-paused={pausedLabel ? "true" : undefined}
    >
      <header className="rgrp-h">
        <span className="rgrp-icon" aria-hidden="true">
          {icon ? <Icon icon={icon} /> : <span className="dot" />}
        </span>
        <div className="rgrp-name">
          <b>{name}</b>
          <span className="rgrp-stats">
            {stats.map((s) => (
              <span key={s}>{s}</span>
            ))}
          </span>
        </div>
        {pct !== null ? (
          <span className="rgrp-conf" data-pct={pct}>
            <span className="meter" aria-hidden="true">
              <span style={{ width: `${pct}%` }} />
            </span>
            <span className="rgrp-conf-label">{confidenceLabel}</span>
          </span>
        ) : null}
        <div className="acts">
          <Btn sm onClick={() => onChangeRule?.(id)}>
            {changeRuleLabel}
          </Btn>
          {onOpen ? (
            <Btn sm onClick={() => onOpen(id)}>
              {openLabel}
            </Btn>
          ) : null}
        </div>
      </header>
      <div className="rgrp-rule">
        <span className="rgrp-label">
          {ruleLabel}
          {pausedLabel ? <Tag>{pausedLabel}</Tag> : null}
        </span>
        {sentence ? (
          <RuleText sentence={sentence} predicate={predicate} />
        ) : (
          <div className="rule empty">
            <div>{noRule}</div>
          </div>
        )}
      </div>
      {always.length || threshold ? (
        <div className="rgrp-always">
          {always.length ? <span className="rgrp-label">{alwaysLabel}</span> : null}
          {always.map((a) => (
            <span key={a} className="rgrp-chip">
              {a}
            </span>
          ))}
          {threshold ? <span className="rgrp-threshold">{threshold}</span> : null}
        </div>
      ) : null}
      {subgroups?.length ? (
        <div className="rgrp-subs">
          {subgroups.map((s) => (
            <button
              type="button"
              key={s.id}
              className="rgrp-sub"
              data-group={s.id}
              onClick={() => onOpenSubgroup?.(s.id)}
            >
              {s.icon ? <Icon icon={s.icon} /> : <span className="dot" aria-hidden="true" />}
              <span className="rgrp-sub-main">
                <b>{s.name}</b>
                {s.description ? <span>{s.description}</span> : null}
              </span>
              {s.count ? <Tag>{s.count}</Tag> : null}
              <Icon icon={CaretRightIcon} className="caret" />
            </button>
          ))}
        </div>
      ) : null}
      {learned ? (
        <div className="rgrp-learned">
          <span>{learned.label}</span>
          <button type="button" className="link" onClick={learned.onToggle}>
            {learned.toggle}
          </button>
          {learned.open ? <div className="rgrp-examples">{learned.body}</div> : null}
        </div>
      ) : null}
      {children}
    </article>
  );
}

export interface RoutedRowProps {
  name: string;
  subject: string;
  /** The Group it went to. */
  target: string;
  /** Why, in plain words: "Matched careers.example.com", "You put it here". */
  why?: string | undefined;
  className?: string | undefined;
}

/** A Thread routing placed, with where it went and why. */
export function RoutedRow({ name, subject, target, why, className }: RoutedRowProps) {
  return (
    <div className={cx("routed", className)}>
      <Avatar name={name} color="var(--fg-muted)" />
      <div className="routed-main">
        <span className="routed-subject">{subject}</span>
        {why ? <span className="routed-why">{why}</span> : null}
      </div>
      <span className="tag">{target}</span>
    </div>
  );
}
