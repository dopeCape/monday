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

/** "Ask for a group": the agent proposes a rule; the Agent host wires it in slice 14. */
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

/** One Thread in Needs a decision: its candidates as buttons, and an X to leave it alone. */
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
          {onLeave && shown.length < 2 ? (
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
