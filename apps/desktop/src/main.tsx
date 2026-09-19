import "@monday/ui/tokens.css";
import "@monday/ui/app.css";
import { draftGhost, draftNote } from "@monday/ui/fixtures";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import type { AccountView } from "./platform/api.ts";
import { platform } from "./platform/tauri.ts";
import { createStoreCalendar, type StoreCalendar } from "./screens/calendar/calendar-data.ts";
import { createStoreComposer, type StoreComposer } from "./screens/compose/store-composer.ts";
import { createStoreInbox, type StoreInbox } from "./screens/inbox/store-inbox.ts";
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
          weights: [8, 3, 2, 1],
          recencyDays: settingsRef.current["search.recency_boost_days"],
          limit: settingsRef.current["search.results_limit"],
          recentMax: settingsRef.current["search.recent_max"],
          olderBatch: settingsRef.current["search.older_batch"],
        }),
        fetchBodies,
      }),
    [store, fetchBodies],
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
        },
        log: (m) => console.warn(`[reader] ${m}`),
      }),
      platform().then((p) =>
        createStoreComposer(store, content, {
          address: ws.address,
          // The browser dev server shows the design fixture's suggestion; the Agent's arrive in slice 14.
          suggestions: p.isTauri ? undefined : { d1: { ghost: draftGhost, note: draftNote } },
        }),
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
  }, [store, content, shell.api, ws.address]);

  // Changed Section rules re-section the stream at once, without a new Cache read.
  const sectionRules = shell.settings["sections.rules"];
  const sectionOrder = shell.settings["sections.order"];
  useEffect(() => {
    settingsRef.current = {
      ...settingsRef.current,
      "sections.rules": sectionRules,
      "sections.order": sectionOrder,
    };
    seams?.inbox.resection();
  }, [seams, sectionRules, sectionOrder]);

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

/** How often the first-run screen asks whether an Account has arrived. */
const FIRST_RUN_POLL_MS = 3000;

/**
 * Picks the Workspace: the first connected Account's in the app, the design
 * fixture's on the browser dev server (no Server there). With a Server and no
 * Account yet, the Accounts screen is the whole app until one is connected.
 */
function WorkspaceGate() {
  const shell = useShell();
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  const server = shell.server;
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
          if (r.accounts.length === 0) timer = setTimeout(tick, FIRST_RUN_POLL_MS);
        })
        .catch(() => {
          if (!stopped) timer = setTimeout(tick, FIRST_RUN_POLL_MS);
        });
    };
    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [server, shell.api]);

  const current = useMemo<CurrentWorkspace | null>(() => {
    if (!server) return FIXTURE_WORKSPACE;
    const first = accounts?.[0];
    return first ? { id: first.workspaceId, accountId: first.id, address: first.address } : null;
  }, [server, accounts]);

  if (server && accounts === null) return null;
  if (!current) {
    return (
      <div className="app" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
        <Settings initialSection="accounts" />
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
