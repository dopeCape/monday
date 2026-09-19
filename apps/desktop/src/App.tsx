// Composes the shell from the layout knobs (ADR 0009): nav full, rail or hidden;
// agent bottom, left or right; then the active screen. The AI level
// (CONTEXT.md) gates the agent here: at `off` no agent column or bar is
// rendered, the layout falls back as if the agent knob were hidden (the
// Setting keeps its value), and no Session is opened. Onboarding is offered
// once per Account, after it is added, and again from "Set me up".

import type { ExternalPending } from "@monday/shared";
import { NavSidebar, Rail } from "@monday/ui";
import {
  automationNav,
  calendarNav,
  counts,
  folders,
  groupIcon,
  groups,
  navWorkspace,
  railItems,
  railTail,
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
import type { AccountView } from "./platform/api.ts";
import { type DeviceProviderKeys, deviceProviderKeys } from "./platform/providerKeys.ts";
import { platform } from "./platform/tauri.ts";
import { Calendar } from "./screens/Calendar.tsx";
import type { CalendarSource } from "./screens/calendar/calendar-data.ts";
import { type Composer, fixtureComposer } from "./screens/compose/composer.ts";
import { Scheduled } from "./screens/compose/Scheduled.tsx";
import { composeStrings } from "./screens/compose/strings.ts";
import { Inbox, type SyncProgress } from "./screens/Inbox.tsx";
import type { Inbox as InboxData } from "./screens/inbox/actions.ts";
import { Onboarding, WELCOME_KEY } from "./screens/Onboarding.tsx";
import {
  ONBOARDING_FIXTURE_SENDERS,
  onboardingFixtureClient,
} from "./screens/onboarding-fixture.ts";
import { Routing } from "./screens/Routing.tsx";
import type { RoutingSource } from "./screens/routing/routing-data.ts";
import { Search } from "./screens/Search.tsx";
import { Settings } from "./screens/Settings.tsx";
import type { RuntimeDetection } from "./screens/settings/render.tsx";
import { Workflows } from "./screens/Workflows.tsx";
import type { WorkflowsApi } from "./screens/workflows/workflow-data.ts";
import type { SearchModule } from "./search/index.ts";
import { useShell } from "./shell/Shell.tsx";
import { useWorkspace } from "./workspace.tsx";

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
  /**
   * The Accounts of this Server, for the onboarding offer: each Account whose
   * onboarding was never offered gets it once. Defaults to the Server's list
   * once a Server is picked; tests pass a list, null offers nothing.
   */
  accounts?: { list(): Promise<{ accounts: AccountView[] }> } | null | undefined;
  /** This Device's provider keys, for the runtime step; the platform keychain by default. */
  keys?: DeviceProviderKeys | null | undefined;
  /** The calendar seam (slice 18): the Calendar screen, the invite bar and the reminders. Absent, the screen is empty. */
  calendar?: CalendarSource | undefined;
}

/** Detection as the Settings screens and onboarding read it, from what the Device found. */
function detectionOf(statuses: ReturnType<typeof useLocalRuntimes>): RuntimeDetection | null {
  if (!statuses) return null;
  return {
    detect: async () =>
      (Object.values(statuses) as Array<(typeof statuses)[keyof typeof statuses]>).map((r) => ({
        cli: r.cli,
        version: r.version,
        path: r.command,
        status: !r.installed ? "missing" : r.loggedIn === false ? "available" : "connected",
      })),
  };
}

/** The senders with the most Threads, most active first, never the owner. */
function topSenders(
  threads: readonly { participants: { name: string; email: string }[] }[],
  me: string,
  limit: number,
): string[] {
  const counts = new Map<string, { name: string; n: number }>();
  for (const t of threads) {
    const p = t.participants[0];
    if (!p || p.email.toLowerCase() === me.toLowerCase()) continue;
    const entry = counts.get(p.email) ?? { name: p.name || p.email, n: 0 };
    entry.n += 1;
    counts.set(p.email, entry);
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map((e) => e.name);
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
  accounts: accountsProp,
  keys: keysProp,
  calendar,
}: AppProps) {
  const shell = useShell();
  const ws = useWorkspace();
  const now = nowProp ?? new Date();
  // Just mail (CONTEXT.md "AI level"): no agent column, no bar, no Session.
  const aiOff = shell.settings["ai.level"] === "off";
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
  /** The Settings section the palette or the URL asked for, and whether to open on the search field. */
  const [settingsSection, setSettingsSection] = useState<string | undefined>(
    () => new URLSearchParams(location.search).get("section") ?? undefined,
  );
  const [settingsSearch, setSettingsSearch] = useState(0);
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
                address: () => ws.address,
                statusOf: (cli) => runtimesRef.current?.[cli] ?? null,
                log: (line) => console.warn(line),
              })
            : apiAgentClient(shell.api)
          : null,
    [agentClient, shell.server, shell.api, shell.spawn, ws.address],
  );
  const pinned = shell.pinned;
  const wantedRuntime = useMemo(() => desiredRuntime(shell.settings), [shell.settings]);
  const detection = useMemo(() => detectionOf(runtimes), [runtimes]);
  const agentSession = useAgentSession({
    client: aiOff ? null : client,
    workspaceId: ws.id,
    context: () => ({ pinned: [...pinned] }),
    newAfterHours: shell.settings["ai.session.new_after_hours"],
    runtime: wantedRuntime,
    developerModeDefault: shell.settings["ai.developer_mode_default"],
    onSettingsChanged: () => void shell.refresh(),
  });
  /** The Account being onboarded, and whether this is "Set me up" again. */
  const [onboarding, setOnboarding] = useState<{
    account: AccountView | null;
    rerun: boolean;
    /** The welcome already asked the level and keymap; open on the conversation. */
    afterWelcome?: boolean;
  } | null>(null);
  const [found, setFound] = useState<AccountView[] | null>(null);
  const foundRef = useRef(found);
  foundRef.current = found;
  const openOnboarding = useCallback((target: AccountView | null, rerun: boolean) => {
    setOnboarding({ account: target ?? foundRef.current?.[0] ?? null, rerun });
    setActive("onboarding");
  }, []);
  // "Set me up" typed into the composer runs onboarding again (docs/spec/onboarding.md).
  const setMeUp = shell.settings["strings.onboarding.set_me_up"].trim().toLowerCase();
  const agent = useMemo(
    () => ({
      ...agentSession,
      send: (text: string) => {
        if (text.trim().toLowerCase().replace(/[.!]$/, "") === setMeUp) {
          openOnboarding(null, true);
          return Promise.resolve();
        }
        return agentSession.send(text);
      },
    }),
    [agentSession, setMeUp, openOnboarding],
  );
  const runtime = runtimeLine(agent.runtimeInfo, shell.settings, ws.address, runtimes);
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
          workflowsClient.runs(ws.id, { status: "paused" }),
          workflowsClient.list(ws.id),
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
  }, [workflowsClient, refreshSeconds, ws.id]);
  // External callers' calls parked on an approval (slice 19): the Workspace's
  // external feed while the client is open, which is also how the Server knows
  // a client is open; each becomes a chip that opens the caller's Session.
  const [externalPending, setExternalPending] = useState<ExternalPending[]>([]);
  const externalClient = shell.server ? shell.api.external : null;
  useEffect(() => {
    if (!externalClient) return;
    let cancelled = false;
    externalClient
      .pending(ws.id)
      .then((list) => {
        if (!cancelled) setExternalPending(list);
      })
      .catch(() => {});
    const stop = externalClient.live(ws.id, (p) =>
      setExternalPending((current) => [
        ...current.filter((x) => x.activityId !== p.activityId),
        ...(p.status === "waiting" ? [p] : []),
      ]),
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, [externalClient, ws.id]);
  const chips = useMemo(
    () =>
      suggestionsFor({
        settings: shell.settings,
        waiting: agent.waiting,
        pausedRuns,
        external: externalPending,
        needsReply: inbox?.threads().filter((t) => t.section === "needs-reply") ?? [],
      }),
    [shell.settings, agent.waiting, pausedRuns, externalPending, inbox],
  );
  /* ------------------------------ Onboarding ------------------------------ */

  const accountsSource =
    accountsProp !== undefined ? accountsProp : shell.server ? shell.api.accounts : null;
  useEffect(() => {
    if (!accountsSource) return;
    let live = true;
    void Promise.all([accountsSource.list(), shell.refresh()])
      .then(([r]) => {
        if (live) setFound(r.accounts);
      })
      .catch(() => {
        if (live) setFound([]);
      });
    return () => {
      live = false;
    };
  }, [accountsSource, shell.refresh]);
  // Each new Account gets its own offer, once: the offer is recorded before the screen shows.
  const shellRef = useRef(shell);
  shellRef.current = shell;
  const offered = useRef(new Set<string>());
  useEffect(() => {
    if (!found) return;
    const state = shellRef.current.settings["onboarding.state"];
    const fresh = found.find((a) => !state[a.id] && !offered.current.has(a.id));
    if (!fresh) return;
    offered.current.add(fresh.id);
    // The welcome already asked the level and the keymap: with AI off there is
    // nothing left to ask, and otherwise the offer opens on the conversation.
    const welcomed = state[WELCOME_KEY] !== undefined;
    const aiOff = shellRef.current.settings["ai.level"] === "off";
    if (welcomed && aiOff) {
      void shellRef.current.set("onboarding.state", {
        ...state,
        [fresh.id]: { status: "completed", at: new Date().toISOString() },
      });
      return;
    }
    void shellRef.current.set("onboarding.state", {
      ...state,
      [fresh.id]: { status: "offered", at: new Date().toISOString() },
    });
    setOnboarding({ account: fresh, rerun: false, afterWelcome: welcomed });
    setActive("onboarding");
  }, [found]);
  const [keys, setKeys] = useState<DeviceProviderKeys | null>(keysProp ?? null);
  useEffect(() => {
    if (keysProp !== undefined) return;
    let live = true;
    void platform().then((p) => {
      if (live) setKeys(deviceProviderKeys(p));
    });
    return () => {
      live = false;
    };
  }, [keysProp]);
  const senders = useMemo(
    () =>
      topSenders(
        inbox?.threads() ?? [],
        onboarding?.account?.address ?? ws.address,
        shell.settings["onboarding.sender_chips"],
      ),
    [inbox, onboarding, shell.settings["onboarding.sender_chips"], ws.address],
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
      onOpenRuntime={() => navigate("settings:ai")}
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
      if (target === "settings:search") {
        setSettingsSearch((n) => n + 1);
        setActive("settings");
      } else if (target === "settings" || target.startsWith("settings:")) {
        if (target.startsWith("settings:")) setSettingsSection(target.slice("settings:".length));
        setActive("settings");
      } else if (target === "search") setActive("search");
      else if (target === "routing") setActive("routing");
      else if (target === "workflows") setActive("workflows");
      else if (target === "calendar") setActive("calendar");
      else if (target === "activity") {
        setSettingsSection("ai");
        setActive("settings");
      } else if (target === "onboarding") openOnboarding(null, true);
      else if (target.startsWith("thread:")) {
        setOpenThread(target.slice("thread:".length));
        setActive("inbox");
      } else if (target.startsWith("group:")) setActive(target.slice("group:".length));
      else if (target.startsWith("folder:")) setActive(target.slice("folder:".length));
      else setActive("inbox");
    },
    [shell, openOnboarding],
  );

  const openSearch = useCallback((query: string) => {
    setSearchQuery(query);
    setActive("search");
  }, []);

  if (active === "onboarding") {
    // The dev server's fixture state: the conversation from the mock, with no Server behind it.
    const fixtureChat =
      !shell.server &&
      agentClient === undefined &&
      new URLSearchParams(location.search).get("step") === "chat";
    return (
      <div
        className="app"
        data-online={online ? "true" : "false"}
        style={{ gridTemplateColumns: "minmax(0, 1fr)" }}
      >
        <Onboarding
          key={`onboarding-${onboarding?.account?.id ?? "none"}-${onboarding?.rerun ? "again" : "first"}`}
          accountId={onboarding?.account?.id ?? ws.accountId}
          workspaceId={onboarding?.account?.workspaceId ?? ws.id}
          address={onboarding?.account?.address ?? ws.address}
          agentClient={fixtureChat ? onboardingFixtureClient(() => now) : client}
          initialStep={fixtureChat || onboarding?.afterWelcome ? "chat" : undefined}
          runtimes={detection}
          keys={keys}
          senders={fixtureChat ? ONBOARDING_FIXTURE_SENDERS : senders}
          threadCount={inbox?.threads().length ?? 0}
          rerun={onboarding?.rerun ?? false}
          now={now}
          onDone={() => setActive("inbox")}
        />
      </div>
    );
  }

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
  if (shell.layout.agent === "left" && !aiOff) {
    cols.push("var(--agent-w)");
    parts.push(column("left"));
  }
  cols.push("minmax(0, 1fr)");
  parts.push(
    active === "settings" ? (
      <Settings
        key={`screen-${settingsSection ?? ""}-${settingsSearch}`}
        initialSection={settingsSection}
        initialSearch={settingsSearch > 0}
        workspaceId={ws.id}
        runtimes={detection ?? undefined}
        keys={keysProp ?? undefined}
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
        workspaceId={ws.id}
        onNavigate={navigate}
      />
    ) : active === "workflows" ? (
      <Workflows
        key="screen"
        workspaceId={ws.id}
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
        workspaceId={ws.id}
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
        workspaceId={ws.id}
        initialOpen={openThread ?? undefined}
        initialAgentText={agentText}
        onNavigate={navigate}
        onSearch={openSearch}
        agent={agent}
        externalPending={externalPending}
        calendar={calendar}
      />
    ),
  );
  if (shell.layout.agent === "right" && !aiOff) {
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
