// One Thread in the list. The same markup serves both list knobs: the CSS
// under :root[data-list="split"] reflows it into two lines.
import type { Tag, Thread } from "@monday/shared";
import { ArchiveIcon, ClockIcon, PaperclipIcon } from "@phosphor-icons/react";
import type { DragEvent, MouseEvent, ReactNode } from "react";
import { cx, formatListTime, highlightParts, personName } from "../format.ts";
import { Icon } from "./icon.tsx";
import { Btn, Mark } from "./primitives.tsx";

export interface MessageRowProps {
  thread: Thread;
  /** The Thread's Tags, resolved; the first one shows as the label. */
  tags?: readonly Tag[] | undefined;
  selected?: boolean | undefined;
  /** For the relative time. Defaults to the wall clock. */
  now?: Date | undefined;
  /** The account the Thread belongs to, shown in the all-accounts search view. */
  account?: string | undefined;
  /** The hover actions' titles, with their keys; the app words them from Settings and the keymap. */
  titles?: { archive?: string; snooze?: string; ask?: string } | undefined;
  onOpen?: ((threadId: string) => void) | undefined;
  onArchive?: ((threadId: string) => void) | undefined;
  onSnooze?: ((threadId: string) => void) | undefined;
  onAsk?: ((threadId: string) => void) | undefined;
  /** Makes the row draggable (into the Agent); the handler fills the drag's data. */
  onDragStart?: ((threadId: string, event: DragEvent<HTMLDivElement>) => void) | undefined;
  onDragEnd?: (() => void) | undefined;
  className?: string | undefined;
  /** Words a search matched, marked in the sender, subject and snippet. */
  highlight?: readonly string[] | undefined;
}

/** Text with the matched words in <mark>. */
function marked(text: string, terms: readonly string[] | undefined): ReactNode {
  if (!terms?.length) return text;
  return highlightParts(text, terms).map((p, i) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one string, in order
    p.hit ? <mark key={i}>{p.text}</mark> : p.text,
  );
}

export function MessageRow({
  thread,
  tags,
  selected,
  now,
  account,
  titles,
  onOpen,
  onArchive,
  onSnooze,
  onAsk,
  onDragStart,
  onDragEnd,
  className,
  highlight,
}: MessageRowProps) {
  const from = personName(thread.participants[0]);
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
      draggable={onDragStart ? true : undefined}
      onDragStart={onDragStart ? (e) => onDragStart(thread.id, e) : undefined}
      onDragEnd={onDragEnd}
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
        {marked(thread.messageCount > 1 ? `${from} ` : from, highlight)}
        {thread.messageCount > 1 ? <span className="cnt">{thread.messageCount}</span> : null}
      </span>
      <span className="subj">
        <b>{marked(thread.subject, highlight)}</b>
        <span className="snip">{marked(thread.snippet, highlight)}</span>
      </span>
      <span className="meta">
        {thread.hasAttachments ? <Icon icon={PaperclipIcon} /> : null}
        {label ? <span className="lbl">{label}</span> : null}
        {account ? <span className="acct">{account}</span> : null}
      </span>
      <span className="time">{formatListTime(thread.lastActivity, now)}</span>
      <span className="actions">
        <Btn icon title={titles?.archive ?? "Archive (E)"} onClick={act(onArchive)}>
          <Icon icon={ArchiveIcon} />
        </Btn>
        <Btn icon title={titles?.snooze ?? "Snooze (H)"} onClick={act(onSnooze)}>
          <Icon icon={ClockIcon} />
        </Btn>
        <Btn icon title={titles?.ask ?? "Ask about this"} onClick={act(onAsk)}>
          <Mark small />
        </Btn>
      </span>
    </div>
  );
}
