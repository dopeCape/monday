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
import {
  type ChangeEvent,
  Fragment,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
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

/** The words on the body's buttons; the app passes its Settings strings. */
export interface MessageStrings {
  showQuoted: string;
  hideQuoted: string;
  showImages: string;
  loading: string;
}

const DEFAULT_MESSAGE_STRINGS: MessageStrings = {
  showQuoted: "Show quoted text",
  hideQuoted: "Hide quoted text",
  showImages: "Show images",
  loading: "Loading",
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
  /** Neither text nor html has arrived yet: the body shows the loading line. */
  loading?: boolean | undefined;
  strings?: Partial<MessageStrings> | undefined;
  /** For the relative time. Defaults to the wall clock. */
  now?: Date | undefined;
  className?: string | undefined;
}

const QUOTED_MARK = 'class="quoted"';
const BLOCKED_MARK = "data-blocked";
const ATTACHMENT_SRC = /^\/attachments\/([^/?#]+)/;

/** Sanitised HTML from the Server, with folded history, blocked images and intercepted links. */
function HtmlBody({
  html,
  collapseQuoted,
  strings,
  onOpenLink,
  attachmentSrc,
}: {
  html: string;
  collapseQuoted: boolean;
  strings: MessageStrings;
  onOpenLink: ((href: string) => void) | undefined;
  attachmentSrc: ((attachmentId: string) => Promise<string>) | undefined;
}) {
  const hasQuoted = html.includes(QUOTED_MARK);
  const hasBlocked = html.includes(BLOCKED_MARK);
  const [quotedOpen, setQuotedOpen] = useState(!collapseQuoted);
  const [imagesShown, setImagesShown] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root || !imagesShown) return;
    for (const img of root.querySelectorAll<HTMLImageElement>("img[data-src]")) {
      const src = img.dataset.src;
      if (src) img.src = src;
    }
  }, [imagesShown]);

  useEffect(() => {
    const root = ref.current;
    if (!root || !attachmentSrc) return;
    let cancelled = false;
    for (const img of root.querySelectorAll<HTMLImageElement>("img")) {
      const raw = img.getAttribute("src") ?? "";
      const m = raw.match(ATTACHMENT_SRC);
      if (!m?.[1]) continue;
      img.removeAttribute("src");
      void attachmentSrc(decodeURIComponent(m[1])).then((url) => {
        if (!cancelled) img.src = url;
      });
    }
    return () => {
      cancelled = true;
    };
  }, [attachmentSrc]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement | null)?.closest?.("a[href]");
    if (!target) return;
    e.preventDefault();
    const href = target.getAttribute("href");
    if (href) onOpenLink?.(href);
  };

  return (
    <>
      <div
        ref={ref}
        className="msg-body"
        data-quoted={hasQuoted ? (quotedOpen ? "open" : "collapsed") : undefined}
        onClick={onClick}
        onKeyDown={undefined}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: the Server sanitised it (apps/server/src/mail/sanitize.ts)
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {hasQuoted || (hasBlocked && !imagesShown) ? (
        <div className="msg-more">
          {hasQuoted ? (
            <Btn sm onClick={() => setQuotedOpen((o) => !o)}>
              {quotedOpen ? strings.hideQuoted : strings.showQuoted}
            </Btn>
          ) : null}
          {hasBlocked && !imagesShown ? (
            <Btn sm onClick={() => setImagesShown(true)}>
              {strings.showImages}
            </Btn>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function Message({
  message,
  collapsed,
  onExpand,
  onOpenAttachment,
  onOpenLink,
  attachmentSrc,
  collapseQuoted = true,
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
      {message.bodyHtml ? (
        <HtmlBody
          html={message.bodyHtml}
          collapseQuoted={collapseQuoted}
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
        <Btn primary onClick={onSend}>
          {strings.send}
        </Btn>
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
