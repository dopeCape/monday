// The reader's parts: the Brief, one Message (open or collapsed), an
// Attachment pill, and the reply box at the bottom.
import type {
  Attachment as AttachmentData,
  BriefAction,
  Brief as BriefData,
  Message as MessageData,
  RichText,
} from "@monday/shared";
import {
  ArrowBendDoubleUpLeftIcon,
  ArrowBendUpRightIcon,
  FileDocIcon,
  FileIcon,
  FilePdfIcon,
  ImageIcon,
  PaperclipIcon,
} from "@phosphor-icons/react";
import { type ChangeEvent, Fragment, type ReactNode } from "react";
import {
  cx,
  firstName,
  formatSize,
  formatWhen,
  paragraphs,
  preview as previewOf,
  uniqueKeys,
} from "../format.ts";
import { Icon, type IconComponent } from "./icon.tsx";
import { Avatar, Btn, Chip, Mark } from "./primitives.tsx";

/* ------------------------------ Brief ------------------------------ */

/** The chip text for a suggested action. */
export function briefActionLabel(action: BriefAction): string {
  return action.label;
}

function Rich({ runs }: { runs: RichText }) {
  return (
    <>
      {runs.map((r, i) =>
        typeof r === "string" ? (
          <Fragment key={i}>{r}</Fragment>
        ) : "b" in r ? (
          <b key={i}>{r.b}</b>
        ) : (
          <i key={i}>{r.i}</i>
        ),
      )}
    </>
  );
}

export interface BriefProps {
  brief: BriefData;
  /** Who wrote it, such as "Claude Code, on this machine". */
  source?: string | undefined;
  /** How many action chips to show. The mock shows three. */
  maxActions?: number | undefined;
  onAction?: ((action: BriefAction) => void) | undefined;
  className?: string | undefined;
}

export function Brief({ brief, source, maxActions = 3, onAction, className }: BriefProps) {
  const actions = brief.actions.slice(0, maxActions);
  return (
    <div className={cx("brief", brief.stale && "stale", className)}>
      <div className="brief-h">
        Brief
        {source ? <span>{source}</span> : null}
      </div>
      <ul>
        {brief.bullets.map((b, i) => (
          <li key={i}>
            <Rich runs={b} />
          </li>
        ))}
      </ul>
      {actions.length ? (
        <div className="brief-actions">
          {actions.map((a) => {
            const label = briefActionLabel(a);
            return (
              <Chip key={label} onClick={() => onAction?.(a)}>
                {label}
              </Chip>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ Attachment ------------------------------ */

export function attachmentIcon(mediaType: string): IconComponent {
  if (mediaType === "application/pdf") return FilePdfIcon;
  if (mediaType.startsWith("image/")) return ImageIcon;
  if (mediaType.includes("word") || mediaType.includes("document")) return FileDocIcon;
  return FileIcon;
}

export interface AttachmentProps {
  attachment: AttachmentData;
  onOpen?: ((attachmentId: string) => void) | undefined;
  className?: string | undefined;
}

export function Attachment({ attachment, onOpen, className }: AttachmentProps) {
  return (
    <button type="button" className={cx("att", className)} onClick={() => onOpen?.(attachment.id)}>
      <Icon icon={attachmentIcon(attachment.mediaType)} />
      <span>{attachment.name}</span>
      <span className="sz">{formatSize(attachment.size)}</span>
    </button>
  );
}

/* ------------------------------ Message ------------------------------ */

/** Single newlines inside a paragraph become line breaks, as in "Best,\nAoife". */
function withBreaks(text: string): ReactNode[] {
  const lines = text.split("\n");
  const keys = uniqueKeys(lines);
  return lines.flatMap((line, i) => (i ? [<br key={keys[i]} />, line] : [line]));
}

export interface MessageProps {
  message: MessageData;
  /** Folded to one line with a preview. Older messages in a Thread start this way. */
  collapsed?: boolean | undefined;
  onExpand?: ((messageId: string) => void) | undefined;
  onOpenAttachment?: ((attachmentId: string) => void) | undefined;
  /** For the relative time. Defaults to the wall clock. */
  now?: Date | undefined;
  className?: string | undefined;
}

export function Message({
  message,
  collapsed,
  onExpand,
  onOpenAttachment,
  now,
  className,
}: MessageProps) {
  const when = formatWhen(message.date, now);
  if (collapsed) {
    return (
      <button
        type="button"
        className={cx("msg", "collapsed", className)}
        onClick={() => onExpand?.(message.id)}
      >
        <div className="msg-head">
          <b>{message.from.name}</b>
          <span className="prev">{previewOf(message.bodyText)}</span>
          <span className="when">{when}</span>
        </div>
      </button>
    );
  }
  const to = message.to.map((p) => firstName(p.name)).join(", ");
  return (
    <div className={cx("msg", className)}>
      <div className="msg-head">
        <Avatar name={message.from.name} />
        <div className="who">
          <b>{message.from.name}</b>
          {to ? <span>{`to ${to}`}</span> : null}
        </div>
        <span className="when">{when}</span>
      </div>
      <div className="msg-body">
        {paragraphs(message.bodyText).map((p) => (
          <p key={p}>{withBreaks(p)}</p>
        ))}
      </div>
      {message.attachments.length ? (
        <div className="attachments">
          {message.attachments.map((a) => (
            <Attachment key={a.id} attachment={a} onOpen={onOpenAttachment} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ ReplyBox ------------------------------ */

export interface ReplyBoxProps {
  /** Who the reply goes to; the placeholder uses their first name. */
  recipient: string;
  value?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
  onSend?: (() => void) | undefined;
  /** Shown when the Agent has draft suggestions for this Thread. */
  onDraft?: (() => void) | undefined;
  onAttach?: (() => void) | undefined;
  onReplyAll?: (() => void) | undefined;
  onForward?: (() => void) | undefined;
  className?: string | undefined;
}

export function ReplyBox({
  recipient,
  value,
  onChange,
  onSend,
  onDraft,
  onAttach,
  onReplyAll,
  onForward,
  className,
}: ReplyBoxProps) {
  return (
    <div className={cx("reply", className)}>
      <textarea
        placeholder={`Reply to ${firstName(recipient)}`}
        {...(onChange
          ? {
              value: value ?? "",
              onChange: (e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value),
            }
          : { defaultValue: value })}
      />
      <div className="reply-bottom">
        <Btn primary onClick={onSend}>
          Send
        </Btn>
        {onDraft ? (
          <Btn onClick={onDraft}>
            <Mark small /> Draft a reply
          </Btn>
        ) : null}
        <span className="sp" />
        <Btn icon title="Attach" onClick={onAttach}>
          <Icon icon={PaperclipIcon} />
        </Btn>
        <Btn icon title="Reply all" onClick={onReplyAll}>
          <Icon icon={ArrowBendDoubleUpLeftIcon} />
        </Btn>
        <Btn icon title="Forward" onClick={onForward}>
          <Icon icon={ArrowBendUpRightIcon} />
        </Btn>
      </div>
    </div>
  );
}
