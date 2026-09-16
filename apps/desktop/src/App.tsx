// Composes the shell from the layout knobs (ADR 0009): nav full, rail or hidden;
// agent bottom, left or right; then the active screen.

import { AgentBar, AgentColumn, AgentThread, NavSidebar, Rail } from "@monday/ui";
import {
  agentThread,
  automationNav,
  calendarNav,
  counts,
  folders,
  groupIcon,
  groups,
  NOW,
  navWorkspace,
  railItems,
  railTail,
  workspace,
} from "@monday/ui/fixtures";
import { useState } from "react";
import { Inbox, type SyncProgress } from "./screens/Inbox.tsx";
import { Settings } from "./screens/Settings.tsx";
import { useShell } from "./shell/Shell.tsx";

export interface AppProps {
  /** Offline turns the workspace dot grey (docs/spec/inbox.md). Slice 6 feeds it. */
  online?: boolean | undefined;
  /** First-sync progress for the inbox's thin line, or null. Slice 6 feeds it. */
  syncing?: SyncProgress | null | undefined;
}

export function App({ online = true, syncing = null }: AppProps) {
  const shell = useShell();
  const [active, setActive] = useState(
    () => new URLSearchParams(location.search).get("screen") ?? "inbox",
  );
  const runtime = `Claude Code · ${workspace.accountId}`;

  const cols: string[] = [];
  const parts: React.ReactNode[] = [];
  if (shell.layout.nav === "full") {
    cols.push("var(--nav-w)");
    parts.push(
      <NavSidebar
        key="nav"
        workspace={navWorkspace}
        folders={folders}
        calendar={calendarNav}
        groups={groups}
        groupIcon={groupIcon}
        counts={counts}
        automation={automationNav}
        active={active}
        onSelect={setActive}
      />,
    );
  }
  if (shell.layout.nav === "rail") {
    cols.push("var(--rail-w)");
    parts.push(
      <Rail
        key="rail"
        workspace={navWorkspace}
        items={railItems}
        tail={railTail}
        active={active}
        onSelect={setActive}
      />,
    );
  }
  if (shell.layout.agent === "left") {
    cols.push("var(--agent-w)");
    parts.push(
      <AgentColumn key="agent-l" side="left" runtime={runtime}>
        <AgentThread turns={agentThread} now={NOW} />
        <AgentBar placeholder="Reply, or ask something else" />
      </AgentColumn>,
    );
  }
  cols.push("minmax(0, 1fr)");
  parts.push(
    active === "settings" ? (
      <Settings key="screen" />
    ) : (
      <Inbox key="screen" online={online} syncing={syncing} />
    ),
  );
  if (shell.layout.agent === "right") {
    cols.push("var(--agent-w)");
    parts.push(
      <AgentColumn key="agent-r" side="right" runtime={runtime}>
        <AgentThread turns={agentThread} now={NOW} />
        <AgentBar placeholder="Reply, or ask something else" />
      </AgentColumn>,
    );
  }

  return (
    <div
      className="app"
      data-online={online ? "true" : "false"}
      style={{ gridTemplateColumns: cols.join(" ") }}
    >
      {parts}
    </div>
  );
}
