// The inbox screen over fixtures. Slice 6 replaces fixtures with the Store; the
// components and layout stay. Behaviors per docs/spec/inbox.md.

import type { Thread } from "@monday/shared";
import {
  AgentBar,
  AgentDock,
  AgentPanel,
  AgentThread,
  Brief,
  Btn,
  ColHead,
  Message,
  MessageRow,
  ReplyBox,
  SectionLabel,
} from "@monday/ui";
import {
  NOW,
  agentThread,
  briefOf,
  messagesOf,
  sections,
  suggestions,
  tagsOf,
  threadsIn,
  workspace,
} from "@monday/ui/fixtures";
import {
  ArchiveIcon,
  ClockIcon,
  DotsThreeIcon,
  FolderSimpleIcon,
  FunnelSimpleIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useShell } from "../shell/Shell.tsx";

export function Inbox() {
  const shell = useShell();
  const stream = shell.layout.list === "stream";
  const [selected, setSelected] = useState<string | null>(stream ? null : "e1");
  const [readerOpen, setReaderOpen] = useState(!stream);
  const [agentOpen, setAgentOpen] = useState(false);

  const open = (id: string) => {
    setSelected(id);
    setReaderOpen(true);
  };
  const thread = selected
    ? (threadsIn("").find((t) => t.id === selected) ?? findThread(selected))
    : null;
  const showReader = stream ? readerOpen && thread : true;

  return (
    <div className={`main inbox ${stream && showReader ? "has-sheet" : ""}`}>
      <section className="col list">
        <ColHead title="Inbox" count={14}>
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
            .filter((s) => !s.hidden)
            .sort((a, b) => a.order - b.order)
            .map((s) => {
              const items = threadsIn(s.id);
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
          sheet={stream}
          onClose={() => setReaderOpen(false)}
          onAsk={() => setAgentOpen(true)}
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

function findThread(id: string): Thread | null {
  for (const s of sections) {
    const t = threadsIn(s.id).find((x) => x.id === id);
    if (t) return t;
  }
  return null;
}

function Reader({
  thread,
  sheet,
  onClose,
  onAsk,
}: {
  thread: Thread;
  sheet: boolean;
  onClose: () => void;
  onAsk: () => void;
}) {
  const messages = messagesOf(thread.id);
  const brief = briefOf(thread.id);
  const last = messages[messages.length - 1];
  return (
    <section className={`col reader ${sheet ? "sheet" : ""}`}>
      <ColHead
        leading={
          sheet ? (
            <>
              <Btn icon title="Close" onClick={onClose}>
                <XIcon />
              </Btn>
              <span className="vr" />
            </>
          ) : null
        }
      >
        <Btn icon title="Archive (E)">
          <ArchiveIcon />
        </Btn>
        <Btn icon title="Snooze (H)">
          <ClockIcon />
        </Btn>
        <Btn icon title="Move">
          <FolderSimpleIcon />
        </Btn>
        <Btn icon title="Delete (#)">
          <TrashIcon />
        </Btn>
        <span className="sp" />
        <Btn onClick={onAsk}>Ask</Btn>
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
