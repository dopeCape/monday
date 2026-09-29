// The reader's parts: the Brief, one Message (open or collapsed), an
// Attachment pill, and the reply box at the bottom.
import type {
  Attachment as AttachmentData,
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
  personName,
  preview as previewOf,
  uniqueKeys,
} from "../format.ts";
import { HtmlBody } from "./html-body.tsx";
import { Icon, type IconComponent } from "./icon.tsx";
import { Avatar, Btn, Mark } from "./primitives.tsx";

/* ------------------------------ Brief ------------------------------ */

function Rich({ runs }: { runs: RichText }) {
  return (
    <>
      {runs.map((r, i) =>
        typeof r === "string" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a Brief's runs are fixed text, never reordered
          <Fragment key={i}>{r}</Fragment>
        ) : "b" in r ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a Brief's runs are fixed text, never reordered
          <b key={i}>{r.b}</b>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a Brief's runs are fixed text, never reordered
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
  /** The word shown in place of the source while a stale Brief waits for a fresh one, such as "Updating". */
  updating?: string | undefined;
  /**
   * The chip row under the bullets: the Custom actions and the Recommended
   * actions (docs/spec/actions.md), already capped and ordered by the caller.
   * The Brief no longer chooses actions of its own.
   */
  chips?: ReactNode | undefined;
  className?: string | undefined;
}

/** The chip row under a Brief, or in its place. */
function ChipRow({ chips }: { chips?: ReactNode | undefined }) {
  if (!chips) return null;
  return <div className="brief-actions">{chips}</div>;
}

export function Brief({ brief, source, updating, chips, className }: BriefProps) {
  const line = brief.stale && updating ? updating : source;
  return (
    <div className={cx("brief", brief.stale && "stale", className)}>
      <div className="brief-h">
        Brief
        {line ? <span>{line}</span> : null}
      </div>
      <ul>
        {brief.bullets.map((b, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the verdicts are indexed by bullet position
          <li key={i} className={brief.verified?.[i] === "partly" ? "partly" : undefined}>
            <Rich runs={b} />
          </li>
        ))}
      </ul>
      <ChipRow chips={chips} />
    </div>
  );
}

export interface ActionChipsProps {
  /** The chips, in the order the caller chose; nothing renders without them. */
  chips?: ReactNode | undefined;
  className?: string | undefined;
}

/**
 * The chip row without a Brief: the Custom actions and the Recommended
 * actions the Thread's Signals suggest, shown where the Brief will sit, at
 * the top of the Thread, before any Brief is written. Renders nothing when
 * there are none.
 */
export function ActionChips({ chips, className }: ActionChipsProps) {
  if (!chips) return null;
  return (
    <div className={cx("brief chips", className)} data-testid="action-chips">
      <ChipRow chips={chips} />
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

/** The words on the body's buttons; the app passes its Settings strings. */
export interface MessageStrings {
  showQuoted: string;
  hideQuoted: string;
  showImages: string;
  loading: string;
  /** The accessible name of the frame an HTML body renders in. */
  frameTitle: string;
}

const DEFAULT_MESSAGE_STRINGS: MessageStrings = {
  showQuoted: "Show quoted text",
  hideQuoted: "Hide quoted text",
  showImages: "Show images",
  loading: "Loading",
  frameTitle: "Message body",
};

export interface MessageProps {
  message: MessageData;
  /** Folded to one line with a preview. Older messages in a Thread start this way. */
  collapsed?: boolean | undefined;
  onExpand?: ((messageId: string) => void) | undefined;
  onOpenAttachment?: ((attachmentId: string) => void) | undefined;
  /** A link in the body was clicked; the app opens it through the opener plugin. */
  onOpenLink?: ((href: string) => void) | undefined;
  /** Resolves an inline part (an <img src="/attachments/:id">) to a URL the webview may load. */
  attachmentSrc?: ((attachmentId: string) => Promise<string>) | undefined;
  /** Quoted history starts folded (a Setting). */
  collapseQuoted?: boolean | undefined;
  /** Remote images load without asking (the reader.load_remote_images Setting). */
  loadRemoteImages?: boolean | undefined;
  /** Neither text nor html has arrived yet: the body shows the loading line. */
  loading?: boolean | undefined;
  strings?: Partial<MessageStrings> | undefined;
  /** For the relative time. Defaults to the wall clock. */
  now?: Date | undefined;
  className?: string | undefined;
}

export function Message({
  message,
  collapsed,
  onExpand,
  onOpenAttachment,
  onOpenLink,
  attachmentSrc,
  collapseQuoted = true,
  loadRemoteImages,
  loading,
  strings: stringOverrides,
  now,
  className,
}: MessageProps) {
  const strings = { ...DEFAULT_MESSAGE_STRINGS, ...(stringOverrides ?? {}) };
  const when = formatWhen(message.date, now);
  if (collapsed) {
    return (
      <button
        type="button"
        className={cx("msg", "collapsed", className)}
        onClick={() => onExpand?.(message.id)}
      >
        <div className="msg-head">
          <b>{personName(message.from)}</b>
          <span className="prev">{previewOf(message.bodyText)}</span>
          <span className="when">{when}</span>
        </div>
      </button>
    );
  }
  const to = message.to.map((p) => firstName(personName(p))).join(", ");
  return (
    <div className={cx("msg", className)}>
      <div className="msg-head">
        <Avatar name={personName(message.from)} />
        <div className="who">
          <b>{personName(message.from)}</b>
          {to ? <span>{`to ${to}`}</span> : null}
        </div>
        <span className="when">{when}</span>
      </div>
      {message.bodyHtml ? (
        <HtmlBody
          html={message.bodyHtml}
          collapseQuoted={collapseQuoted}
          loadRemoteImages={loadRemoteImages}
          strings={strings}
          onOpenLink={onOpenLink}
          attachmentSrc={attachmentSrc}
        />
      ) : (
        <div className="msg-body">
          {loading && !message.bodyText ? <p className="faint">{strings.loading}</p> : null}
          {paragraphs(message.bodyText).map((p) => (
            <p key={p}>{withBreaks(p)}</p>
          ))}
        </div>
      )}
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

export interface ReplyBoxStrings {
  /** "Reply to {name}"; the first name fills {name}. */
  placeholder: string;
  send: string;
  draft: string;
  attach: string;
  replyAll: string;
  forward: string;
}

const DEFAULT_REPLY_STRINGS: ReplyBoxStrings = {
  placeholder: "Reply to {name}",
  send: "Send",
  draft: "Draft a reply",
  attach: "Attach",
  replyAll: "Reply all",
  forward: "Forward",
};

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
  /** The reply-all toggle is on (ADR 0010); the button shows as pressed. */
  replyAll?: boolean | undefined;
  /** Replaces the textarea: the rich text editor, recipients, quoted history. */
  editor?: ReactNode | undefined;
  /** Rendered above the bottom row: attachments, toolbar, the forward checkbox. */
  extra?: ReactNode | undefined;
  /** Rendered after the send button: the saved line. */
  status?: ReactNode | undefined;
  /** Why Send is refused ("Fill invoice number first"): the button is disabled and the line says so. */
  sendBlocked?: string | null | undefined;
  strings?: Partial<ReplyBoxStrings> | undefined;
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
  replyAll,
  editor,
  extra,
  status,
  sendBlocked,
  strings: stringOverrides,
  className,
}: ReplyBoxProps) {
  const strings = { ...DEFAULT_REPLY_STRINGS, ...(stringOverrides ?? {}) };
  return (
    <div className={cx("reply", className)}>
      {editor ?? (
        <textarea
          placeholder={strings.placeholder.replace("{name}", firstName(recipient))}
          {...(onChange
            ? {
                value: value ?? "",
                onChange: (e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value),
              }
            : { defaultValue: value })}
        />
      )}
      {extra}
      <div className="reply-bottom">
        <Btn
          primary
          onClick={onSend}
          disabled={Boolean(sendBlocked)}
          title={sendBlocked || undefined}
        >
          {strings.send}
        </Btn>
        {sendBlocked ? (
          <span className="c-status c-blocked" role="status">
            {sendBlocked}
          </span>
        ) : null}
        {onDraft ? (
          <Btn onClick={onDraft}>
            <Mark small /> {strings.draft}
          </Btn>
        ) : null}
        {status}
        <span className="sp" />
        <Btn icon title={strings.attach} onClick={onAttach}>
          <Icon icon={PaperclipIcon} />
        </Btn>
        <Btn icon title={strings.replyAll} on={replyAll} onClick={onReplyAll}>
          <Icon icon={ArrowBendDoubleUpLeftIcon} />
        </Btn>
        <Btn icon title={strings.forward} onClick={onForward}>
          <Icon icon={ArrowBendUpRightIcon} />
        </Btn>
      </div>
    </div>
  );
}
