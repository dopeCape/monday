// The inbox screen over the Store (ADR 0009): sections, rows, the reader's
// messages and Brief are live queries against the Cache; the toolbar actions
// are intents, applied locally before the Server hears of them so a row never
// flickers. The agent dock still shows fixture turns until slice 14.
// Behaviors per docs/spec/inbox.md.

import type { SectionRule, Tag, Thread } from "@monday/shared";
import {
  AgentBar,
  AgentDock,
  AgentPanel,
  AgentThread,
  Brief,
  Btn,
  ColHead,
  Mark,
  Message,
  MessageRow,
  ReplyBox,
  SectionLabel,
} from "@monday/ui";
import { agentThread, NOW, suggestions, workspace } from "@monday/ui/fixtures";
import {
  ArchiveIcon,
  ClockIcon,
  DotsThreeIcon,
  FolderSimpleIcon,
  FunnelSimpleIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useCallback, useMemo, useState } from "react";
import { useShell } from "../shell/Shell.tsx";
import {
  BRIEF_OF_THREAD_SQL,
  INBOX_THREADS_SQL,
  MESSAGES_OF_THREAD_SQL,
  rowToBrief,
  rowToMessage,
  rowToSection,
  rowToTag,
  rowToThread,
  SECTIONS_SQL,
  TAGS_SQL,
  THREAD_BY_ID_SQL,
  useLive,
  useStore,
} from "../store/index.ts";

const NO_PARAMS: never[] = [];

/** Snooze until tomorrow 08:00 local; the presets become Settings in slice 7. */
function tomorrowMorning(now: Date): string {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.toISOString();
}

export function Inbox() {
  const shell = useShell();
  const store = useStore();
  const stream = shell.layout.list === "stream";
  const initial = new URLSearchParams(location.search).get("sel");
  const [selected, setSelected] = useState<string | null>(initial ?? (stream ? null : "e1"));
  const [readerOpen, setReaderOpen] = useState(!stream || initial !== null);
  const [agentOpen, setAgentOpen] = useState(false);

  const workspaceId = store.workspaceId;
  const mapThreads = useCallback(
    (rows: Record<string, unknown>[]) => rows.map((r) => rowToThread(r, workspaceId)),
    [workspaceId],
  );
  const mapSections = useCallback(
    (rows: Record<string, unknown>[]) => rows.map((r) => rowToSection(r, workspaceId)),
    [workspaceId],
  );
  const mapTags = useCallback(
    (rows: Record<string, unknown>[]) => rows.map((r) => rowToTag(r, workspaceId)),
    [workspaceId],
  );
  const threads = useLive(INBOX_THREADS_SQL, NO_PARAMS, mapThreads) ?? [];
  const sections = useLive(SECTIONS_SQL, NO_PARAMS, mapSections) ?? [];
  const tags = useLive(TAGS_SQL, NO_PARAMS, mapTags) ?? [];
  const tagsOf = useCallback(
    (t: Thread): Tag[] => t.tags.flatMap((id) => tags.filter((tag) => tag.id === id)),
    [tags],
  );

  // The selected Thread stays readable after it leaves the stream (archived, snoozed).
  const selectedParams = useMemo(() => [selected ?? ""], [selected]);
  const selectedRows = useLive(THREAD_BY_ID_SQL, selectedParams, mapThreads);
  const thread = selected ? (selectedRows?.[0] ?? null) : null;

  const open = (id: string) => {
    setSelected(id);
    setReaderOpen(true);
  };
  const showReader = stream ? readerOpen && thread : true;

  return (
    <div className={`main inbox ${stream && showReader ? "has-sheet" : ""}`}>
      <section className="col list">
        <ColHead title="Inbox" count={threads.length}>
          {stream ? (
            <Btn>
              <FunnelSimpleIcon /> Filter
            </Btn>
          ) : null}
          <Btn icon title="More">
            <DotsThreeIcon />
          </Btn>
        </ColHead>
        <div className="col-body">
          {sections
            .filter((s: SectionRule) => !s.hidden)
            .sort((a, b) => a.order - b.order)
            .map((s) => {
              const items = threads.filter((t) => t.section === s.id);
              if (items.length === 0) return null;
              return (
                <div key={s.id}>
                  <SectionLabel>{s.name}</SectionLabel>
                  {items.map((t) => (
                    <MessageRow
                      key={t.id}
                      thread={t}
                      tags={tagsOf(t)}
                      selected={t.id === selected}
                      now={NOW}
                      onOpen={open}
                    />
                  ))}
                </div>
              );
            })}
        </div>
      </section>

      {showReader && thread ? (
        <Reader
          thread={thread}
          tags={tagsOf(thread)}
          sheet={stream}
          onClose={() => setReaderOpen(false)}
          onAsk={() => setAgentOpen(true)}
          onArchive={() => void store.intent({ kind: "archive", threadId: thread.id })}
          onSnooze={() =>
            void store.intent({ kind: "snooze", threadId: thread.id, until: tomorrowMorning(NOW) })
          }
          onDelete={() => void store.intent({ kind: "delete", threadId: thread.id })}
        />
      ) : null}

      {shell.layout.agent === "bottom" ? (
        <AgentDock>
          {agentOpen ? (
            <AgentPanel
              runtime={`Claude Code · ${workspace.accountId}`}
              suggestions={suggestions}
              onClose={() => setAgentOpen(false)}
            >
              <AgentThread turns={agentThread} now={NOW} />
            </AgentPanel>
          ) : null}
          <AgentBar
            placeholder={agentOpen ? "Reply, or ask something else" : "Ask or tell monday"}
            onFocus={() => setAgentOpen(true)}
          />
        </AgentDock>
      ) : null}
    </div>
  );
}

function Reader({
  thread,
  tags,
  sheet,
  onClose,
  onAsk,
  onArchive,
  onSnooze,
  onDelete,
}: {
  thread: Thread;
  tags: Tag[];
  sheet: boolean;
  onClose: () => void;
  onAsk: () => void;
  onArchive: () => void;
  onSnooze: () => void;
  onDelete: () => void;
}) {
  const params = useMemo(() => [thread.id], [thread.id]);
  const messages = useLive(MESSAGES_OF_THREAD_SQL, params, mapMessages) ?? [];
  const brief = useLive(BRIEF_OF_THREAD_SQL, params, mapBriefs)?.[0];
  const last = messages[messages.length - 1];
  return (
    <section className={`col reader ${sheet ? "sheet" : ""}`}>
      <ColHead
        leading={
          <>
            {sheet ? (
              <>
                <Btn icon title="Close" onClick={onClose}>
                  <XIcon />
                </Btn>
                <span className="vr" />
              </>
            ) : null}
            <Btn icon title="Archive (E)" onClick={onArchive}>
              <ArchiveIcon />
            </Btn>
            <Btn icon title="Snooze (H)" onClick={onSnooze}>
              <ClockIcon />
            </Btn>
            <Btn icon title="Move">
              <FolderSimpleIcon />
            </Btn>
            <Btn icon title="Delete (#)" onClick={onDelete}>
              <TrashIcon />
            </Btn>
          </>
        }
      >
        <Btn onClick={onAsk}>
          <Mark small /> Ask
        </Btn>
        <Btn icon title="More">
          <DotsThreeIcon />
        </Btn>
      </ColHead>
      <div className="reader-body">
        <div className="reader-inner">
          <h1>{thread.subject}</h1>
          <div className="subline">
            {thread.participants[0]?.name} · {thread.messageCount} message
            {thread.messageCount === 1 ? "" : "s"}
            {tags.length ? ` · ${tags.map((t) => t.name).join(", ")}` : ""}
          </div>
          {brief ? <Brief brief={brief} source="Claude Code, on this machine" /> : null}
          {messages.map((m, i) => (
            <Message key={m.id} message={m} collapsed={i < messages.length - 1} now={NOW} />
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

const mapMessages = (rows: Record<string, unknown>[]) => rows.map(rowToMessage);
const mapBriefs = (rows: Record<string, unknown>[]) => rows.map(rowToBrief);
