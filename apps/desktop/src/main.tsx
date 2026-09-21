import "@monday/ui/tokens.css";
import "@monday/ui/app.css";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import type { AccountView } from "./platform/api.ts";
import { platform } from "./platform/tauri.ts";
import { createStoreCalendar, type StoreCalendar } from "./screens/calendar/calendar-data.ts";
import { createStoreComposer, type StoreComposer } from "./screens/compose/store-composer.ts";
import { createStoreInbox, type StoreInbox } from "./screens/inbox/store-inbox.ts";
import { Onboarding, WELCOME_KEY } from "./screens/Onboarding.tsx";
import { createStoreRouting, type StoreRouting } from "./screens/routing/routing-data.ts";
import { Settings } from "./screens/Settings.tsx";
import { createSearch, type FetchBodies } from "./search/index.ts";
import { createPrewarm } from "./search/prewarm.ts";
import { Shell, useShell } from "./shell/Shell.tsx";
import {
  StoreProvider,
  useContent,
  useStore,
  useStoreStatus,
  useSyncProgress,
} from "./store/index.ts";
import {
  type CurrentWorkspace,
  FIXTURE_WORKSPACE,
  useWorkspace,
  WorkspaceProvider,
} from "./workspace.tsx";

/**
 * The app over the Store: the inbox and compose seams, the workspace dot, the
 * sync line, search and the pre-warm Job.
 */
function Root() {
  const store = useStore();
  const content = useContent();
  const shell = useShell();
  const ws = useWorkspace();
  const settingsRef = useRef(shell.settings);
  settingsRef.current = shell.settings;
  const status = useStoreStatus();
  const progress = useSyncProgress();
  const [seams, setSeams] = useState<{
    inbox: StoreInbox;
    composer: StoreComposer;
    routing: StoreRouting;
    calendar: StoreCalendar;
  } | null>(null);

  // The bulk body route: "search older mail" and the pre-warm Job share it.
  const fetchBodies = useMemo<FetchBodies>(
    () => (workspaceId, range) => shell.api.messages.bodies(workspaceId, range),
    [shell.api],
  );

  const search = useMemo(
    () =>
      createSearch({
        sources: () => [{ store, account: ws.address }],
        settings: () => ({
          weights: settingsRef.current["search.weights"],
          recencyDays: settingsRef.current["search.recency_boost_days"],
          limit: settingsRef.current["search.results_limit"],
          recentMax: settingsRef.current["search.recent_max"],
          olderBatch: settingsRef.current["search.older_batch"],
        }),
        fetchBodies,
      }),
    [store, fetchBodies, ws.address],
  );

  // The pre-warm Job runs only against a live Sidecar; the browser dev server has none.
  useEffect(() => {
    if (!shell.sidecar?.running) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void platform().then((p) => {
      if (cancelled) return;
      const prewarm = createPrewarm({
        store,
        fetchBodies,
        conditions: { network: () => p.network(), power: () => p.power() },
        settings: () => ({
          windowDays: settingsRef.current["search.cache_window_days"],
          capGb: settingsRef.current["search.cache_cap_gb"],
          onMetered: settingsRef.current["search.prewarm_on_metered"],
          onBattery: settingsRef.current["search.prewarm_on_battery"],
          batch: settingsRef.current["search.prewarm_batch"],
        }),
        log: (m) => console.info(`[search] ${m}`),
      });
      stop = prewarm.start();
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [store, fetchBodies, shell.sidecar]);

  const browser = shell.host === "browser";
  useEffect(() => {
    if (!content) return;
    let closed = false;
    let opened: {
      inbox: StoreInbox;
      composer: StoreComposer;
      routing: StoreRouting;
      calendar: StoreCalendar;
    } | null = null;
    let routingSeam: StoreRouting | null = null;
    void Promise.all([
      createStoreRouting(store).then((r) => {
        routingSeam = r;
        return r;
      }),
      createStoreCalendar(store, shell.api),
      createStoreInbox(store, {
        content,
        remoteImages: () => settingsRef.current["reader.load_remote_images"],
        level: () => settingsRef.current["ai.level"],
        // The Section rules run here, on the client, over the Cache (CONTEXT.md "Section rule").
        sections: {
          rules: () => settingsRef.current["sections.rules"],
          order: () => settingsRef.current["sections.order"],
          owner: ws.address,
          groupNames: () =>
            Object.fromEntries((routingSeam?.groups() ?? []).map((g) => [g.id, g.name])),
          // A judged Section or action asks the Server for what the rules leave open (slice 26).
          judgeThreshold: () => settingsRef.current["sections.judge_threshold"],
          judgeBatch: () => settingsRef.current["sections.judge_batch"],
          actions: () => settingsRef.current["actions.custom"],
        },
        log: (m) => console.warn(`[reader] ${m}`),
      }),
      // The browser dev server shows the design fixture's suggestion on its
      // Draft; the fixtures load only there, never in the app.
      (!browser
        ? Promise.resolve(undefined)
        : import("@monday/ui/fixtures").then((fx) => ({
            d1: { ghost: fx.draftGhost, note: fx.draftNote },
          }))
      ).then((suggestions) =>
        createStoreComposer(store, content, { address: ws.address, suggestions }),
      ),
    ]).then(([routing, calendar, inbox, composer]) => {
      if (closed) {
        inbox.close();
        composer.close();
        routing.close();
        calendar.close();
      } else {
        opened = { inbox, composer, routing, calendar };
        setSeams(opened);
      }
    });
    return () => {
      closed = true;
      opened?.inbox.close();
      opened?.composer.close();
      opened?.routing.close();
      opened?.calendar.close();
    };
  }, [store, content, shell.api, ws.address, browser]);

  // Changed Section rules or custom actions re-section the stream at once,
  // without a new Cache read; a Section the Agent just made shows this way.
  const sectionRules = shell.settings["sections.rules"];
  const sectionOrder = shell.settings["sections.order"];
  const judgeThreshold = shell.settings["sections.judge_threshold"];
  const customActions = shell.settings["actions.custom"];
  useEffect(() => {
    settingsRef.current = {
      ...settingsRef.current,
      "sections.rules": sectionRules,
      "sections.order": sectionOrder,
      "sections.judge_threshold": judgeThreshold,
      "actions.custom": customActions,
    };
    seams?.inbox.resection();
  }, [seams, sectionRules, sectionOrder, judgeThreshold, customActions]);

  if (!seams) return null;
  return (
    <App
      inbox={seams.inbox}
      composer={seams.composer}
      routing={seams.routing}
      calendar={seams.calendar}
      online={status === "online" || status === "syncing"}
      syncing={progress}
      search={search}
    />
  );
}

/**
 * Picks the Workspace: the first connected Account's in the app, the design
 * fixture's on the browser dev server (no Server there). In the app nothing
 * renders until the Sidecar (or the Cloud) answers, so the fixture Workspace
 * never opens a Cache there. With a Server and no Account yet, the Accounts
 * screen is the whole app until one is connected.
 */
function WorkspaceGate() {
  const shell = useShell();
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  const server = shell.server;
  const pollMs = shell.settings["server.first_run_poll_seconds"] * 1000;
  useEffect(() => {
    if (!server) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      shell.api.accounts
        .list()
        .then((r) => {
          if (stopped) return;
          setAccounts(r.accounts);
          if (r.accounts.length === 0) timer = setTimeout(tick, pollMs);
        })
        .catch(() => {
          if (!stopped) timer = setTimeout(tick, pollMs);
        });
    };
    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [server, shell.api, pollMs]);

  const current = useMemo<CurrentWorkspace | null>(() => {
    if (shell.host === "browser" && !server) return FIXTURE_WORKSPACE;
    const first = accounts?.[0];
    return first ? { id: first.workspaceId, accountId: first.id, address: first.address } : null;
  }, [shell.host, server, accounts]);

  // In the app a Sidecar that reported a failure, or a Server that has not
  // answered within one reachability check, shows the Server section (which
  // says what happened and offers the Cloud) rather than a blank window.
  const waitMs = shell.settings["server.probe_seconds"] * 1000;
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (shell.host !== "tauri" || server) {
      setWaited(false);
      return;
    }
    const timer = setTimeout(() => setWaited(true), waitMs);
    return () => clearTimeout(timer);
  }, [shell.host, server, waitMs]);

  // The host is unknown, the Sidecar is still starting, or the Accounts have not answered.
  if (shell.host === null || (server && accounts === null)) return null;
  if (shell.host === "tauri" && !server) {
    if (!waited && !shell.sidecarError) return null;
    return (
      <div className="app" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
        <Settings initialSection="server" />
      </div>
    );
  }
  if (!current) {
    // First run: the level cards, the keymap, then the first Account. Once the
    // welcome has run (or was skipped), the Accounts screen waits for one.
    const welcomed = shell.settings["onboarding.state"][WELCOME_KEY] !== undefined;
    return (
      <div className="app" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
        {welcomed ? (
          <Settings initialSection="accounts" />
        ) : (
          <Onboarding
            mode="welcome"
            accountId={WELCOME_KEY}
            workspaceId=""
            address=""
            agentClient={null}
            onDone={() => void shell.refresh()}
          />
        )}
      </div>
    );
  }
  return (
    <WorkspaceProvider value={current}>
      <StoreProvider workspaceId={current.id}>
        <Root />
      </StoreProvider>
    </WorkspaceProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Shell>
      <WorkspaceGate />
    </Shell>
  </StrictMode>,
);
