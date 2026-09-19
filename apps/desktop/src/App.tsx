// Composes the shell from the layout knobs (ADR 0009): nav full, rail or hidden;
// agent bottom, left or right; then the active screen.

import { NavSidebar, Rail } from "@monday/ui";
import {
  account,
  automationNav,
  calendarNav,
  counts,
  folders,
  groupIcon,
  groups,
  navWorkspace,
  railItems,
  railTail,
  workspace,
} from "@monday/ui/fixtures";
import { ClockIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Composer as AgentComposer, composerStrings } from "./agent/Composer.tsx";
import { type AgentClient, apiAgentClient } from "./agent/client.ts";
import { deviceAgentClient } from "./agent/deviceClient.ts";
import { desiredRuntime, runtimeLine } from "./agent/runtimeLine.ts";
import { useLocalRuntimes } from "./agent/runtimes/useLocalRuntimes.ts";
import { type PausedRunChip, suggestionsFor } from "./agent/suggestions.ts";
import { useAgentSession } from "./agent/useAgentSession.ts";
import { useEventReminders } from "./calendar/reminders.ts";
import { Calendar } from "./screens/Calendar.tsx";
import type { CalendarSource } from "./screens/calendar/calendar-data.ts";
import { type Composer, fixtureComposer } from "./screens/compose/composer.ts";
import { Scheduled } from "./screens/compose/Scheduled.tsx";
import { composeStrings } from "./screens/compose/strings.ts";
import { Inbox, type SyncProgress } from "./screens/Inbox.tsx";
import type { Inbox as InboxData } from "./screens/inbox/actions.ts";
import { Routing } from "./screens/Routing.tsx";
import type { RoutingSource } from "./screens/routing/routing-data.ts";
import { Search } from "./screens/Search.tsx";
import { Settings } from "./screens/Settings.tsx";
import { Workflows } from "./screens/Workflows.tsx";
import type { WorkflowsApi } from "./screens/workflows/workflow-data.ts";
import type { SearchModule } from "./search/index.ts";
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
  /** The Cache search behind the palette and the results screen (ADR 0011). */
  search?: SearchModule | null | undefined;
  /** Groups and Needs a decision from the Store; the nav and the Routing page read them. Fixtures when absent. */
  routing?: RoutingSource | undefined;
  /**
   * The composer's seam to the Agent host. Defaults to the Server's routes
   * over the Shell's Api once a Server is picked; tests pass a fake, null
   * keeps the bar inert.
   */
  agentClient?: AgentClient | null | undefined;
  /** The wall clock for the composer's relative times. */
  now?: Date | undefined;
  /** The Workflows page's Server side; the Shell's client or the fixture by default, a fake in tests. */
  workflowsApi?: WorkflowsApi | undefined;
  /** The calendar seam (slice 18): the Calendar screen, the invite bar and the reminders. Absent, the screen is empty. */
  calendar?: CalendarSource | undefined;
}

const defaultComposer = fixtureComposer();
const noSubscribe = () => () => {};
const noGroups = () => groups;

export function App({
  inbox,
  composer = defaultComposer,
  online = true,
  syncing = null,
  search = null,
  routing,
  agentClient,
  now: nowProp,
  workflowsApi,
  calendar,
}: AppProps) {
  const shell = useShell();
  const now = nowProp ?? new Date();
  // Desktop notifications before an Event starts (Settings: notifications.*).
  useEventReminders(calendar, shell.settings);
  const storeGroups = useSyncExternalStore(
    routing?.subscribe ?? noSubscribe,
    routing?.groups ?? noGroups,
    routing?.groups ?? noGroups,
  );
  const navGroups = routing ? storeGroups : groups;
  const [active, setActive] = useState(
    () => new URLSearchParams(location.search).get("screen") ?? "inbox",
  );
  const [composeRequest, setComposeRequest] = useState(0);
  const [searchQuery, setSearchQuery] = useState(
    () => new URLSearchParams(location.search).get("q") ?? "",
  );
  /** A Thread the results screen asked to open; the inbox reads it on mount. */
  const [openThread, setOpenThread] = useState<string | null>(null);
  /** Text the agent bar opens with after a palette handoff. */
  const [agentText, setAgentText] = useState<string | undefined>(undefined);
  /** The Settings section the palette or the URL asked for. */
  const [settingsSection, setSettingsSection] = useState<string | undefined>(
    () => new URLSearchParams(location.search).get("section") ?? undefined,
  );
  /** The column composers' own text; the bottom bar's lives in the Inbox. */
  const [columnText, setColumnText] = useState("");
  const settingsRef = useRef(shell.settings);
  settingsRef.current = shell.settings;
  const sidecarRef = useRef(shell.sidecar);
  sidecarRef.current = shell.sidecar;
  // What this Device found of the three CLIs; null where nothing can be spawned.
  const runtimes = useLocalRuntimes(shell.spawn, shell.settings);
  const runtimesRef = useRef(runtimes);
  runtimesRef.current = runtimes;
  // In the app the Device client drives a Local runtime itself and sends Hosted turns
  // to the Server; the browser dev server, with no processes to spawn, stays Hosted.
  const client = useMemo(
    () =>
      agentClient !== undefined
        ? agentClient
        : shell.server
          ? shell.spawn
            ? deviceAgentClient({
                api: shell.api,
                runner: shell.spawn,
                sidecar: () => {
                  const s = sidecarRef.current;
                  return s?.running ? { port: s.port, token: s.token } : null;
                },
                settings: () => settingsRef.current,
                address: () => account.address,
                statusOf: (cli) => runtimesRef.current?.[cli] ?? null,
                log: (line) => console.warn(line),
              })
            : apiAgentClient(shell.api)
          : null,
    [agentClient, shell.server, shell.api, shell.spawn],
  );
  const pinned = shell.pinned;
  const wantedRuntime = useMemo(() => desiredRuntime(shell.settings), [shell.settings]);
  const agent = useAgentSession({
    client,
    workspaceId: workspace.id,
    context: () => ({ pinned: [...pinned] }),
    newAfterHours: shell.settings["ai.session.new_after_hours"],
    runtime: wantedRuntime,
    developerModeDefault: shell.settings["ai.developer_mode_default"],
    onSettingsChanged: () => void shell.refresh(),
  });
  const runtime = runtimeLine(agent.runtimeInfo, shell.settings, account.address, runtimes);
  const agentStrings = useMemo(() => composerStrings(shell.settings), [shell.settings]);
  // Workflow Runs paused at a Step that asks surface as chips (slice 16); the
  // Agent's approve_workflow_step tool then shows the card in the composer.
  const [pausedRuns, setPausedRuns] = useState<PausedRunChip[]>([]);
  const workflowsClient = workflowsApi ?? (shell.server ? shell.api.workflows : null);
  const refreshSeconds = shell.settings["workflows.page.refresh_seconds"];
  useEffect(() => {
    if (!workflowsClient) return;
    let cancelled = false;
    const load = async () => {
      try {
        const [runs, list] = await Promise.all([
          workflowsClient.runs(workspace.id, { status: "paused" }),
          workflowsClient.list(workspace.id),
        ]);
        if (cancelled) return;
        setPausedRuns(
          runs.map((r) => ({
            workflowName: list.find((w) => w.id === r.workflowId)?.name ?? r.workflowId,
            stepName: r.steps.find((s) => s.index === r.waitingStep)?.name ?? "waiting",
          })),
        );
      } catch {
        if (!cancelled) setPausedRuns([]);
      }
    };
    void load();
    const timer = refreshSeconds > 0 ? setInterval(() => void load(), refreshSeconds * 1000) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [workflowsClient, refreshSeconds]);
  const chips = useMemo(
    () =>
      suggestionsFor({
        settings: shell.settings,
        waiting: agent.waiting,
        pausedRuns,
        needsReply: inbox?.threads().filter((t) => t.section === "needs-reply") ?? [],
      }),
    [shell.settings, agent.waiting, pausedRuns, inbox],
  );
  const column = (side: "left" | "right") => (
    <AgentComposer
      key={`agent-${side}`}
      agent={agent}
      mode={side}
      runtime={runtime}
      strings={agentStrings}
      suggestions={chips}
      now={now}
      placeholder={shell.settings["strings.agent.placeholder_open"]}
      text={columnText}
      onTextChange={setColumnText}
      onOpenThread={(id) => navigate(`thread:${id}`)}
    />
  );
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

  /** The palette's "Go to" targets, from any screen. */
  const navigate = useCallback(
    (target: string) => {
      const view = /^view:(\d)$/.exec(target);
      if (view) {
        const v = shell.settings["views.list"][Number(view[1]) - 1];
        if (v) {
          void shell.set("layout.nav", v.layout.nav);
          void shell.set("layout.agent", v.layout.agent);
          void shell.set("layout.list", v.layout.list);
        }
        return;
      }
      if (target === "settings" || target.startsWith("settings:")) {
        if (target.startsWith("settings:")) setSettingsSection(target.slice("settings:".length));
        setActive("settings");
      } else if (target === "search") setActive("search");
      else if (target === "routing") setActive("routing");
      else if (target === "workflows") setActive("workflows");
      else if (target === "calendar") setActive("calendar");
      else if (target === "activity") setActive("settings");
      else if (target.startsWith("thread:")) {
        setOpenThread(target.slice("thread:".length));
        setActive("inbox");
      } else if (target.startsWith("group:")) setActive(target.slice("group:".length));
      else if (target.startsWith("folder:")) setActive(target.slice("folder:".length));
      else setActive("inbox");
    },
    [shell],
  );

  const openSearch = useCallback((query: string) => {
    setSearchQuery(query);
    setActive("search");
  }, []);

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
        groups={navGroups}
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
    parts.push(column("left"));
  }
  cols.push("minmax(0, 1fr)");
  parts.push(
    active === "settings" ? (
      <Settings
        key={`screen-${settingsSection ?? ""}`}
        initialSection={settingsSection}
        workspaceId={workspace.id}
        onAsk={(text) => {
          setAgentText(text);
          setActive("inbox");
        }}
      />
    ) : active === "routing" ? (
      <Routing
        key="screen"
        routing={routing}
        inbox={inbox}
        workspaceId={workspace.id}
        onNavigate={navigate}
      />
    ) : active === "workflows" ? (
      <Workflows
        key="screen"
        workspaceId={workspace.id}
        api={workflowsApi}
        groupName={(id) => {
          const g = navGroups.find((x) => x.id === id);
          if (!g) return id;
          const parent = g.parentId ? navGroups.find((x) => x.id === g.parentId) : null;
          return parent ? `${parent.name} › ${g.name}` : g.name;
        }}
        onNavigate={navigate}
        onAsk={(text) => {
          setAgentText(text);
          setActive("inbox");
        }}
        now={now}
      />
    ) : active === "calendar" && calendar ? (
      <Calendar
        key="screen"
        source={calendar}
        now={now}
        onNavigate={navigate}
        onAsk={(text) => {
          setAgentText(text);
          setActive("inbox");
        }}
      />
    ) : active === "scheduled" ? (
      <div key="screen" className="main inbox">
        <Scheduled composer={composer} strings={strings.scheduled} now={new Date()} />
      </div>
    ) : active === "search" && search ? (
      <Search
        key="screen"
        search={search}
        workspaceId={workspace.id}
        query={searchQuery}
        onQuery={setSearchQuery}
        recentThreads={inbox?.threads().slice(0, 20) ?? []}
        onOpen={(threadId) => {
          setOpenThread(threadId);
          setActive("inbox");
        }}
        onBack={() => setActive("inbox")}
        onCommand={(command) => {
          if (command.type === "navigate") navigate(command.target);
          else if (command.type === "ask" || command.type === "suggest") {
            setAgentText(command.text);
            setActive("inbox");
          }
        }}
        onAsk={(ask) => {
          setAgentText(ask.text);
          setActive("inbox");
        }}
      />
    ) : (
      <Inbox
        key="screen"
        inbox={inbox}
        composer={composer}
        online={online}
        syncing={syncing}
        composeRequest={composeRequest}
        search={search}
        workspaceId={workspace.id}
        initialOpen={openThread ?? undefined}
        initialAgentText={agentText}
        onNavigate={navigate}
        onSearch={openSearch}
        agent={agent}
        calendar={calendar}
      />
    ),
  );
  if (shell.layout.agent === "right") {
    cols.push("var(--agent-w)");
    parts.push(column("right"));
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
