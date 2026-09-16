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
import { ClockIcon } from "@phosphor-icons/react";
import { useState, useSyncExternalStore } from "react";
import { type Composer, fixtureComposer } from "./screens/compose/composer.ts";
import { Scheduled } from "./screens/compose/Scheduled.tsx";
import { composeStrings } from "./screens/compose/strings.ts";
import { Inbox, type SyncProgress } from "./screens/Inbox.tsx";
import type { Inbox as InboxData } from "./screens/inbox/actions.ts";
import { Settings } from "./screens/Settings.tsx";
import { useShell } from "./shell/Shell.tsx";

export interface AppProps {
  /** The inbox's data seam; the Store's implementation in the app, fixtures in tests. */
  inbox?: InboxData | undefined;
  /** The compose seam; the Store's implementation in the app, in memory in tests. */
  composer?: Composer | undefined;
  /** Offline turns the workspace dot grey (docs/spec/inbox.md). The Store feeds it. */
  online?: boolean | undefined;
  /** First-sync progress for the inbox's thin line, or null. The Store feeds it. */
  syncing?: SyncProgress | null | undefined;
}

const defaultComposer = fixtureComposer();

export function App({
  inbox,
  composer = defaultComposer,
  online = true,
  syncing = null,
}: AppProps) {
  const shell = useShell();
  const [active, setActive] = useState(
    () => new URLSearchParams(location.search).get("screen") ?? "inbox",
  );
  const [composeRequest, setComposeRequest] = useState(0);
  const runtime = `Claude Code · ${workspace.accountId}`;
  const sends = useSyncExternalStore(composer.subscribe, composer.sends, composer.sends);
  const pending = sends.filter((s) => s.status === "scheduled").length;
  const strings = composeStrings(shell.settings);
  const navFolders =
    pending > 0
      ? [
          ...folders,
          { key: "scheduled", label: strings.scheduled.title, icon: ClockIcon, count: pending },
        ]
      : folders;
  const onCompose = () => {
    setActive("inbox");
    setComposeRequest((n) => n + 1);
  };

  const cols: string[] = [];
  const parts: React.ReactNode[] = [];
  if (shell.layout.nav === "full") {
    cols.push("var(--nav-w)");
    parts.push(
      <NavSidebar
        key="nav"
        workspace={navWorkspace}
        folders={navFolders}
        calendar={calendarNav}
        groups={groups}
        groupIcon={groupIcon}
        counts={counts}
        automation={automationNav}
        active={active}
        onSelect={setActive}
        onCompose={onCompose}
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
        onCompose={onCompose}
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
    ) : active === "scheduled" ? (
      <div key="screen" className="main inbox">
        <Scheduled composer={composer} strings={strings.scheduled} now={new Date()} />
      </div>
    ) : (
      <Inbox
        key="screen"
        inbox={inbox}
        composer={composer}
        online={online}
        syncing={syncing}
        composeRequest={composeRequest}
      />
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
