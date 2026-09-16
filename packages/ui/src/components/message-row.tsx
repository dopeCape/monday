// One Thread in the list. The same markup serves both list knobs: the CSS
// under :root[data-list="split"] reflows it into two lines.
import type { Tag, Thread } from "@monday/shared";
import { ArchiveIcon, ClockIcon, PaperclipIcon } from "@phosphor-icons/react";
import type { MouseEvent } from "react";
import { cx, formatListTime } from "../format.ts";
import { Icon } from "./icon.tsx";
import { Btn, Mark } from "./primitives.tsx";

export interface MessageRowProps {
  thread: Thread;
  /** The Thread's Tags, resolved; the first one shows as the label. */
  tags?: readonly Tag[] | undefined;
  selected?: boolean | undefined;
  /** For the relative time. Defaults to the wall clock. */
  now?: Date | undefined;
  onOpen?: ((threadId: string) => void) | undefined;
  onArchive?: ((threadId: string) => void) | undefined;
  onSnooze?: ((threadId: string) => void) | undefined;
  onAsk?: ((threadId: string) => void) | undefined;
  className?: string | undefined;
}

export function MessageRow({
  thread,
  tags,
  selected,
  now,
  onOpen,
  onArchive,
  onSnooze,
  onAsk,
  className,
}: MessageRowProps) {
  const from = thread.participants[0]?.name ?? "";
  const label = tags?.[0]?.name;
  const act = (fn: ((id: string) => void) | undefined) => (e: MouseEvent) => {
    e.stopPropagation();
    fn?.(thread.id);
  };
  return (
    <div
      className={cx("row", thread.unread && "unread", selected && "on", className)}
      role="option"
      aria-selected={selected ?? false}
      data-thread={thread.id}
      onClick={() => onOpen?.(thread.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen?.(thread.id);
      }}
      tabIndex={-1}
    >
      {thread.unread ? (
        <span className="dot" role="img" aria-label="Unread" />
      ) : (
        <span className="dot" />
      )}
      <span className="from">
        {thread.messageCount > 1 ? `${from} ` : from}
        {thread.messageCount > 1 ? <span className="cnt">{thread.messageCount}</span> : null}
      </span>
      <span className="subj">
        <b>{thread.subject}</b>
        <span className="snip">{thread.snippet}</span>
      </span>
      <span className="meta">
        {thread.hasAttachments ? <Icon icon={PaperclipIcon} /> : null}
        {label ? <span className="lbl">{label}</span> : null}
      </span>
      <span className="time">{formatListTime(thread.lastActivity, now)}</span>
      <span className="actions">
        <Btn icon title="Archive (E)" onClick={act(onArchive)}>
          <Icon icon={ArchiveIcon} />
        </Btn>
        <Btn icon title="Snooze (H)" onClick={act(onSnooze)}>
          <Icon icon={ClockIcon} />
        </Btn>
        <Btn icon title="Ask about this" onClick={act(onAsk)}>
          <Mark small />
        </Btn>
      </span>
    </div>
  );
}
