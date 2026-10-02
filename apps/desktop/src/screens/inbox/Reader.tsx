// The reader: toolbar, title, Brief, the Messages with collapsed history
// that expands on click, and the reply box. Toolbar actions go through
// InboxActions via the callbacks so they get the same undo toasts as the list.
// The chip row under the Brief, or at the top of the Thread before any Brief
// is written, is one row the screen builds (recommended.ts): the Custom
// actions first (CONTEXT.md "Custom action"), then the meeting chips, then
// the Recommended actions (docs/spec/actions.md), each with its Tier's
// affordance and its key; the same Custom actions render in the toolbar
// after the built-in buttons.
// Bodies are the Cache's (filled on open through the content routes);
// attachments download through the opener; links open through it too.

import type { Brief as BriefData, Message as MessageData, Tag, Thread, Tier } from "@monday/shared";
import {
  ActionChips,
  Brief,
  Btn,
  Chip,
  ColHead,
  Mark,
  Message,
  type MessageStrings,
  personName,
  ReplyBox,
} from "@monday/ui";
import {
  ArchiveIcon,
  ArrowBendUpLeftIcon,
  ArrowBendUpRightIcon,
  BellSlashIcon,
  CalendarCheckIcon,
  CalendarPlusIcon,
  CaretDownIcon,
  ClockIcon,
  CreditCardIcon,
  DotsThreeIcon,
  EnvelopeSimpleIcon,
  EnvelopeSimpleOpenIcon,
  FlowArrowIcon,
  FolderSimpleIcon,
  LightningIcon,
  PackageIcon,
  StarIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type AnimationEvent, type ReactNode, useEffect, useState } from "react";
import { useShownThread } from "../compose/bus.ts";
import { Picker } from "./Picker.tsx";
import type { ReaderChip } from "./recommended.ts";
import { useExit } from "./useExit.ts";

export interface ReaderStrings {
  close: string;
  archive: string;
  snooze: string;
  move: string;
  delete: string;
  ask: string;
  more: string;
  star: string;
  unstar: string;
  unread: string;
  read: string;
  message: string;
  messages: string;
  briefSource: string;
  /** Shown in place of the source while a stale Brief waits for a fresh one. */
  briefUpdating: string;
  /** "Reply to {name}" */
  replyTo: string;
  send: string;
  draftReply: string;
  attach: string;
  replyAll: string;
  forward: string;
  /** The tooltip suffix on a custom action that asks before it runs. */
  asksFirst: string;
  /** The name of a chip's menu button. */
  chipMenu?: string | undefined;
}

/** A meeting chip as the reader shows it (docs/spec/meetings.md): its words and what kind it is. */
export interface ReaderMeetingChip {
  kind: string;
  label: string;
  title: string;
}

/** A custom action as the reader shows it: its label and the Tier it renders with. */
export interface ReaderAction {
  id: string;
  label: string;
  tier: Tier;
}

/** A chip's Phosphor icon by what it does; a Custom action's chip has none. */
function chipIcon(c: ReaderChip): ReactNode {
  if (c.kind === "meeting") return <CalendarPlusIcon />;
  if (c.kind === "follow_up") return <ClockIcon />;
  if (c.kind !== "recommended") return null;
  switch (c.rec.kind) {
    case "reply":
    case "delegate":
      return <ArrowBendUpLeftIcon />;
    case "forward":
      return <ArrowBendUpRightIcon />;
    case "archive":
      return <ArchiveIcon />;
    case "snooze":
      return <ClockIcon />;
    case "rsvp":
      return <CalendarCheckIcon />;
    case "calendar":
      return <CalendarPlusIcon />;
    case "pay":
      return <CreditCardIcon />;
    case "unsubscribe":
      return <BellSlashIcon />;
    case "track":
      return <PackageIcon />;
    case "workflow":
      return <FlowArrowIcon />;
  }
}

export interface ReaderProps {
  thread: Thread;
  messages: readonly MessageData[];
  /** Open on this Message: unfolded and scrolled to (a View row that is one Message). */
  focusMessage?: string | null | undefined;
  brief: BriefData | undefined;
  /**
   * The chip row, in order and already capped (recommended.ts readerChips):
   * Custom actions, meeting chips, Recommended actions. Shown under the Brief,
   * or at the top of the Thread before any Brief exists.
   */
  chips?: readonly ReaderChip[] | undefined;
  /** The keys that run the chips in order (actions.recommended.keys), for their tooltips. */
  chipKeys?: readonly string[] | undefined;
  tags: readonly Tag[];
  sheet: boolean;
  now: Date;
  strings: ReaderStrings;
  messageStrings?: Partial<MessageStrings> | undefined;
  /** Hotkeys for the toolbar titles, as the UI prints them. */
  keys: { archive: string; snooze: string; delete: string; close: string; read?: string };
  /** Quoted history starts folded (a Setting). */
  collapseQuoted?: boolean | undefined;
  /** The reader.load_remote_images Setting: HTML bodies show remote images without asking. */
  loadRemoteImages?: boolean | undefined;
  /** The reply box, once a reply is open; the mock's textarea otherwise. */
  reply?: ReactNode | undefined;
  /**
   * The Thread's open Drafts not open in the reply box, as draft cards: after
   * the last Message and before the reply box, never looking like a Message.
   */
  drafts?: ReactNode | undefined;
  onClose: () => void;
  onAsk: () => void;
  /** The reply box's Draft a reply: a turn about this Thread; the bare Ask when absent. */
  onDraftReply?: (() => void) | undefined;
  onArchive: () => void;
  onSnooze: () => void;
  onMove: () => void;
  onDelete: () => void;
  onStar: () => void;
  onToggleRead: () => void;
  /** The user wants to answer: focus in the reply box, R, A or F, the reply-all or forward buttons. */
  onReply?: ((kind: "reply" | "forward", replyAll?: boolean) => void) | undefined;
  /** A chip was clicked (or its key pressed); the screen runs it as its tool call with its Tier. `option` is an RSVP's answer. */
  onChip?: ((chip: ReaderChip, option?: string) => void) | undefined;
  /** An item of a chip's menu was picked. */
  onChipMenu?: ((chip: ReaderChip, item: string) => void) | undefined;
  /** Rendered under the chips: the unsubscribe card, with the exact request it asks about. */
  chipCard?: ReactNode | undefined;
  /** The custom actions that apply to this Thread, in the toolbar after the built-in buttons and as chips. */
  actions?: readonly ReaderAction[] | undefined;
  /** A custom action was clicked; the screen runs it with its Tier. */
  onAction?: ((actionId: string) => void) | undefined;
  /** "Make a template from this" in the More menu, on a Thread the owner wrote in (docs/spec/templates.md). */
  makeTemplate?: { label: string; run: () => void } | undefined;
  onOpenAttachment?: ((attachmentId: string) => void) | undefined;
  onOpenLink?: ((href: string) => void) | undefined;
  attachmentSrc?: ((attachmentId: string) => Promise<string>) | undefined;
  /** Rendered between the Brief and the Messages: the invite bar. */
  banner?: ReactNode | undefined;
  /** The sheet is on its way out (the screen's exit hook): its leave animation runs, then onLeft. */
  leaving?: boolean | undefined;
  onLeft?: (() => void) | undefined;
}

export function Reader({
  thread,
  messages,
  focusMessage,
  brief,
  chips,
  chipKeys,
  tags,
  sheet,
  now,
  strings,
  messageStrings,
  keys,
  collapseQuoted,
  loadRemoteImages,
  reply,
  drafts,
  onClose,
  onAsk,
  onDraftReply,
  onArchive,
  onSnooze,
  onMove,
  onDelete,
  onStar,
  onToggleRead,
  onReply,
  onChip,
  onChipMenu,
  chipCard,
  actions,
  onAction,
  makeTemplate,
  onOpenAttachment,
  onOpenLink,
  attachmentSrc,
  banner,
  leaving,
  onLeft,
}: ReaderProps) {
  // The compose controller learns which Thread shows, so a reply Draft saved on
  // it (the user's or the Agent's) opens as the inline reply, ready to continue.
  useShownThread(leaving ? null : thread.id);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // Opened on one Message (a View row that is a Message): it unfolds and scrolls into view.
  useEffect(() => {
    if (!focusMessage || !messages.some((m) => m.id === focusMessage)) return;
    setExpanded((s) => (s.has(focusMessage) ? s : new Set(s).add(focusMessage)));
    const at = requestAnimationFrame(() =>
      document
        .querySelector(`[data-message="${CSS.escape(focusMessage)}"]`)
        ?.scrollIntoView({ block: "start" }),
    );
    return () => cancelAnimationFrame(at);
  }, [focusMessage, messages]);
  const [more, setMore] = useState(false);
  /** The chip whose menu is open, by its key. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const moreExit = useExit(more, "--t-fast");
  // A new Thread in the same reader (J and K in the split list) starts with its menu closed.
  const [menuThread, setMenuThread] = useState(thread.id);
  if (menuThread !== thread.id) {
    setMenuThread(thread.id);
    setMore(false);
    setMenuFor(null);
  }
  const onAnimationEnd = (e: AnimationEvent<HTMLElement>) => {
    if (leaving && e.target === e.currentTarget) onLeft?.();
  };
  const last = messages[messages.length - 1];
  const count =
    thread.messageCount === 1
      ? strings.message
      : strings.messages.replace("{n}", String(thread.messageCount));
  const title = (label: string, key: string) => `${label} (${key})`;
  const recipient = personName(last?.from ?? thread.participants[0]);

  /** The small button that opens a chip's menu ("Not this", "Not for mail from ..."). */
  const menuButton = (c: ReaderChip) => (
    <Btn
      icon
      sm
      className="chip-menu"
      title={strings.chipMenu ?? ""}
      aria-label={strings.chipMenu ?? ""}
      aria-expanded={menuFor === c.key}
      onClick={() => setMenuFor((m) => (m === c.key ? null : c.key))}
    >
      <CaretDownIcon />
    </Btn>
  );

  // One row: each chip with its Tier's affordance and, for the first few, its key.
  const chipNodes = chips?.length
    ? chips.map((c, i) => {
        const key = chipKeys?.[i];
        const tier = c.kind === "meeting" ? null : c.tier;
        const asks = tier === "always-ask" ? ` (${strings.asksFirst})` : "";
        const base = c.title ?? c.label;
        const title = key ? `${base}${asks} (${key})` : `${base}${asks}`;
        // An RSVP is one grouped control: the three answers, and the clash when there is one.
        if (c.kind === "recommended" && c.options?.length) {
          return (
            <fieldset
              key={c.key}
              className="chip-group recommended-chip"
              data-chip={c.rec.kind}
              data-tier={c.tier}
              aria-label={c.label}
              title={title}
            >
              <CalendarCheckIcon />
              {c.options.map((o) => (
                <Chip key={o.key} data-option={o.key} onClick={() => onChip?.(c, o.key)}>
                  {o.label}
                </Chip>
              ))}
              {c.title ? <span className="chip-note">{c.title}</span> : null}
              {c.menu?.length ? menuButton(c) : null}
            </fieldset>
          );
        }
        const chip = (
          <Chip
            key={c.key}
            className={
              c.kind === "custom"
                ? "custom-action"
                : c.kind === "meeting"
                  ? "meeting-chip"
                  : "recommended-chip"
            }
            data-chip={c.kind === "recommended" ? c.rec.kind : c.kind}
            {...(c.kind === "custom" ? { "data-action": c.id } : {})}
            {...(c.kind === "meeting" ? { "data-meeting": c.meeting } : {})}
            data-tier={tier ?? undefined}
            title={title}
            onClick={() => onChip?.(c)}
          >
            {chipIcon(c)}
            {c.kind === "custom" ? null : " "}
            {c.label}
          </Chip>
        );
        if (c.kind !== "recommended" || !c.menu?.length) return chip;
        return (
          <span key={c.key} className="chip-group">
            {chip}
            {menuButton(c)}
          </span>
        );
      })
    : null;
  const openMenu = chips?.find((c) => c.key === menuFor);

  return (
    <section
      className={`col reader${sheet ? " sheet" : ""}${leaving ? " leaving" : ""}`}
      data-thread={thread.id}
      onAnimationEnd={onAnimationEnd}
    >
      <ColHead
        leading={
          <>
            {sheet ? (
              <>
                <Btn icon title={title(strings.close, keys.close)} onClick={onClose}>
                  <XIcon />
                </Btn>
                <span className="vr" />
              </>
            ) : null}
            <Btn icon title={title(strings.archive, keys.archive)} onClick={onArchive}>
              <ArchiveIcon />
            </Btn>
            <Btn icon title={title(strings.snooze, keys.snooze)} onClick={onSnooze}>
              <ClockIcon />
            </Btn>
            <Btn icon title={strings.move} onClick={onMove}>
              <FolderSimpleIcon />
            </Btn>
            <Btn icon title={title(strings.delete, keys.delete)} onClick={onDelete}>
              <TrashIcon />
            </Btn>
            <Btn
              icon
              title={
                keys.read
                  ? title(thread.unread ? strings.read : strings.unread, keys.read)
                  : thread.unread
                    ? strings.read
                    : strings.unread
              }
              aria-label={thread.unread ? strings.read : strings.unread}
              data-toggle="read"
              onClick={onToggleRead}
            >
              {thread.unread ? <EnvelopeSimpleOpenIcon /> : <EnvelopeSimpleIcon />}
            </Btn>
            {actions?.length ? <span className="vr" /> : null}
            {actions?.map((a) => (
              <Btn
                key={a.id}
                sm
                title={a.tier === "always-ask" ? `${a.label} (${strings.asksFirst})` : a.label}
                data-action={a.id}
                data-tier={a.tier}
                onClick={() => onAction?.(a.id)}
              >
                <LightningIcon /> {a.label}
              </Btn>
            ))}
          </>
        }
      >
        <Btn onClick={onAsk}>
          <Mark small /> {strings.ask}
        </Btn>
        <Btn icon title={strings.more} onClick={() => setMore((m) => !m)}>
          <DotsThreeIcon />
        </Btn>
      </ColHead>
      {moreExit.mounted ? (
        <Picker
          label={strings.more}
          items={[
            { key: "star", label: thread.starred ? strings.unstar : strings.star },
            ...(makeTemplate ? [{ key: "template", label: makeTemplate.label }] : []),
          ]}
          onPick={(key) => {
            setMore(false);
            if (key === "template") makeTemplate?.run();
            else onStar();
          }}
          onClose={() => setMore(false)}
          leaving={moreExit.leaving}
          onLeft={moreExit.onEnd}
        />
      ) : null}
      <div className="reader-body">
        <div className="reader-inner" key={thread.id}>
          <h1>
            {thread.subject}
            {thread.starred ? <StarIcon weight="fill" aria-label={strings.star} /> : null}
          </h1>
          <div className="subline">
            {personName(thread.participants[0])} · {count}
            {tags.length ? ` · ${tags.map((t) => t.name).join(", ")}` : ""}
          </div>
          {brief ? (
            <Brief
              brief={brief}
              source={strings.briefSource}
              updating={strings.briefUpdating}
              chips={chipNodes}
            />
          ) : (
            <ActionChips chips={chipNodes} />
          )}
          {openMenu && openMenu.kind === "recommended" && openMenu.menu?.length ? (
            <Picker
              label={strings.chipMenu ?? openMenu.label}
              items={openMenu.menu}
              onPick={(item) => {
                setMenuFor(null);
                onChipMenu?.(openMenu, item);
              }}
              onClose={() => setMenuFor(null)}
            />
          ) : null}
          {chipCard}
          {banner}
          {messages.map((m, i) => (
            <Message
              key={m.id}
              message={m}
              collapsed={i < messages.length - 1 && !expanded.has(m.id)}
              onExpand={(id) => setExpanded((s) => new Set(s).add(id))}
              onOpenAttachment={onOpenAttachment}
              onOpenLink={onOpenLink}
              attachmentSrc={attachmentSrc}
              collapseQuoted={collapseQuoted}
              loadRemoteImages={loadRemoteImages}
              loading={m.bodyText === undefined && m.bodyHtml === undefined}
              strings={messageStrings}
              now={now}
            />
          ))}
          {drafts}
          {reply ?? (
            <ReplyBox
              recipient={recipient}
              strings={{
                placeholder: strings.replyTo,
                send: strings.send,
                draft: strings.draftReply,
                attach: strings.attach,
                replyAll: strings.replyAll,
                forward: strings.forward,
              }}
              editor={
                <textarea
                  placeholder={strings.replyTo.replace(
                    "{name}",
                    recipient.split(/\s+/)[0] ?? recipient,
                  )}
                  aria-label={strings.replyTo.replace("{name}", recipient)}
                  onFocus={() => onReply?.("reply")}
                  readOnly
                />
              }
              onSend={() => onReply?.("reply")}
              onDraft={onDraftReply ?? onAsk}
              onAttach={() => onReply?.("reply")}
              onReplyAll={() => onReply?.("reply", true)}
              onForward={() => onReply?.("forward")}
            />
          )}
        </div>
      </div>
    </section>
  );
}
