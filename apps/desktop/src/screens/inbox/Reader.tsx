// The reader: toolbar, title, Brief, the Messages with collapsed history
// that expands on click, and the reply box. Toolbar actions go through
// InboxActions via the callbacks so they get the same undo toasts as the list.

import type { Brief as BriefData, Message as MessageData, Tag, Thread } from "@monday/shared";
import { Brief, Btn, ColHead, Mark, Message, ReplyBox } from "@monday/ui";
import {
  ArchiveIcon,
  ClockIcon,
  DotsThreeIcon,
  FolderSimpleIcon,
  StarIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Picker } from "./Picker.tsx";

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
}

export interface ReaderProps {
  thread: Thread;
  messages: readonly MessageData[];
  brief: BriefData | undefined;
  tags: readonly Tag[];
  sheet: boolean;
  now: Date;
  strings: ReaderStrings;
  /** Hotkeys for the toolbar titles, as the UI prints them. */
  keys: { archive: string; snooze: string; delete: string; close: string };
  onClose: () => void;
  onAsk: () => void;
  onArchive: () => void;
  onSnooze: () => void;
  onMove: () => void;
  onDelete: () => void;
  onStar: () => void;
  onToggleRead: () => void;
}

export function Reader({
  thread,
  messages,
  brief,
  tags,
  sheet,
  now,
  strings,
  keys,
  onClose,
  onAsk,
  onArchive,
  onSnooze,
  onMove,
  onDelete,
  onStar,
  onToggleRead,
}: ReaderProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [more, setMore] = useState(false);
  const last = messages[messages.length - 1];
  const count =
    thread.messageCount === 1
      ? strings.message
      : strings.messages.replace("{n}", String(thread.messageCount));
  const title = (label: string, key: string) => `${label} (${key})`;

  return (
    <section className={`col reader ${sheet ? "sheet" : ""}`} data-thread={thread.id}>
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
      {more ? (
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
        />
      ) : null}
      <div className="reader-body">
        <div className="reader-inner">
          <h1>
            {thread.subject}
            {thread.starred ? <StarIcon weight="fill" aria-label={strings.star} /> : null}
          </h1>
          <div className="subline">
            {thread.participants[0]?.name} · {count}
            {tags.length ? ` · ${tags.map((t) => t.name).join(", ")}` : ""}
          </div>
          {brief ? <Brief brief={brief} source={strings.briefSource} /> : null}
          {messages.map((m, i) => (
            <Message
              key={m.id}
              message={m}
              collapsed={i < messages.length - 1 && !expanded.has(m.id)}
              onExpand={(id) => setExpanded((s) => new Set(s).add(id))}
              now={now}
            />
          ))}
          <ReplyBox
            recipient={last?.from.name ?? thread.participants[0]?.name ?? ""}
            onDraft={onAsk}
          />
        </div>
      </div>
    </section>
  );
}
