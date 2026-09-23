// The reader: toolbar, title, Brief, the Messages with collapsed history
// that expands on click, and the reply box. Toolbar actions go through
// InboxActions via the callbacks so they get the same undo toasts as the list.
// The chip row under the Brief is one row: the Brief's own chips when a
// Brief exists, else the chips the Thread's Judgments suggest (slice 25),
// then the custom actions (CONTEXT.md "Custom action", slice 26), each with
// its Tier's affordance; the same custom actions render in the toolbar after
// the built-in buttons.
// Bodies are the Cache's (filled on open through the content routes);
// attachments download through the opener; links open through it too.

import type {
  BriefAction,
  Brief as BriefData,
  Message as MessageData,
  Tag,
  Thread,
  Tier,
} from "@monday/shared";
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
  ClockIcon,
  DotsThreeIcon,
  FolderSimpleIcon,
  LightningIcon,
  StarIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type AnimationEvent, type ReactNode, useState } from "react";
import { useShownThread } from "../compose/bus.ts";
import { Picker } from "./Picker.tsx";
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
}

/** A custom action as the reader shows it: its label and the Tier it renders with. */
export interface ReaderAction {
  id: string;
  label: string;
  tier: Tier;
}

export interface ReaderProps {
  thread: Thread;
  messages: readonly MessageData[];
  brief: BriefData | undefined;
  /** Action chips from the Thread's Judgments, shown until a Brief exists; the Brief's own chips then win (slice 25). */
  chips?: readonly BriefAction[] | undefined;
  tags: readonly Tag[];
  sheet: boolean;
  now: Date;
  strings: ReaderStrings;
  messageStrings?: Partial<MessageStrings> | undefined;
  /** Hotkeys for the toolbar titles, as the UI prints them. */
  keys: { archive: string; snooze: string; delete: string; close: string };
  /** Quoted history starts folded (a Setting). */
  collapseQuoted?: boolean | undefined;
  /** The reader.load_remote_images Setting: HTML bodies show remote images without asking. */
  loadRemoteImages?: boolean | undefined;
  /** The reply box, once a reply is open; the mock's textarea otherwise. */
  reply?: ReactNode | undefined;
  onClose: () => void;
  onAsk: () => void;
  onArchive: () => void;
  onSnooze: () => void;
  onMove: () => void;
  onDelete: () => void;
  onStar: () => void;
  onToggleRead: () => void;
  /** The user wants to answer: focus in the reply box, R, A or F, the reply-all or forward buttons. */
  onReply?: ((kind: "reply" | "forward", replyAll?: boolean) => void) | undefined;
  /** A Brief action chip was clicked; the screen runs it as a tool call (docs/spec/inbox.md, Briefs). */
  onBriefAction?: ((action: BriefAction) => void) | undefined;
  /** The custom actions that apply to this Thread, in the toolbar after the built-in buttons and as chips. */
  actions?: readonly ReaderAction[] | undefined;
  /** A custom action was clicked; the screen runs it with its Tier. */
  onAction?: ((actionId: string) => void) | undefined;
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
  brief,
  chips,
  tags,
  sheet,
  now,
  strings,
  messageStrings,
  keys,
  collapseQuoted,
  loadRemoteImages,
  reply,
  onClose,
  onAsk,
  onArchive,
  onSnooze,
  onMove,
  onDelete,
  onStar,
  onToggleRead,
  onReply,
  onBriefAction,
  actions,
  onAction,
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
  const [more, setMore] = useState(false);
  const moreExit = useExit(more, "--t-fast");
  // A new Thread in the same reader (J and K in the split list) starts with its menu closed.
  const [menuThread, setMenuThread] = useState(thread.id);
  if (menuThread !== thread.id) {
    setMenuThread(thread.id);
    setMore(false);
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

  // The custom actions as chips, after the model's in the same row, each with its Tier.
  const customChips = actions?.length
    ? actions.map((a) => (
        <Chip
          key={a.id}
          className="custom-action"
          data-action={a.id}
          data-tier={a.tier}
          title={a.tier === "always-ask" ? strings.asksFirst : undefined}
          onClick={() => onAction?.(a.id)}
        >
          {a.label}
        </Chip>
      ))
    : null;

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
            { key: "read", label: thread.unread ? strings.read : strings.unread },
          ]}
          onPick={(key) => {
            setMore(false);
            if (key === "star") onStar();
            else onToggleRead();
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
              onAction={onBriefAction}
              extra={customChips}
            />
          ) : (
            <ActionChips actions={chips ?? []} onAction={onBriefAction} extra={customChips} />
          )}
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
              onDraft={onAsk}
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
