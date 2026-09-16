// Composes the shell from the layout knobs (ADR 0009): nav full, rail or hidden;
// agent bottom, left or right; then the active screen.

import { AgentBar, AgentColumn, AgentThread, NavSidebar, Rail } from "@monday/ui";
import {
  NOW,
  agentThread,
  automationNav,
  calendarNav,
  counts,
  folders,
  groups,
  navWorkspace,
  railItems,
  railTail,
  workspace,
} from "@monday/ui/fixtures";
import { useState } from "react";
import { Inbox } from "./screens/Inbox.tsx";
import { useShell } from "./shell/Shell.tsx";

export function App() {
  const shell = useShell();
  const [active, setActive] = useState("inbox");
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
  parts.push(<Inbox key="screen" />);
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
    <div className="app" style={{ gridTemplateColumns: cols.join(" ") }}>
      {parts}
    </div>
  );
}
