import "@monday/ui/tokens.css";
import "@monday/ui/app.css";
import { Btn, Toast } from "@monday/ui";
import { type ReactNode, StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import type { DraftMemory, DraftStatus } from "./calendar/drafts.ts";
import { newMailNotice } from "./notifications/new-mail.ts";
import type { AccountView } from "./platform/api.ts";
import { platform, platformNotifier } from "./platform/tauri.ts";
import { createStoreCalendar, type StoreCalendar } from "./screens/calendar/calendar-data.ts";
import { createStoreComposer, type StoreComposer } from "./screens/compose/store-composer.ts";
import { FirstSyncGate } from "./screens/FirstSync.tsx";
import { FirstSyncFixture } from "./screens/first-sync/fixture.tsx";
import { type ReadyNotice, useInboxReady, windowInFront } from "./screens/first-sync/ready.ts";
import { createStoreInbox, type StoreInbox } from "./screens/inbox/store-inbox.ts";
import { Onboarding, WELCOME_KEY } from "./screens/Onboarding.tsx";
import { createStoreRouting, type StoreRouting } from "./screens/routing/routing-data.ts";
import { Settings } from "./screens/Settings.tsx";
import { createSearch, type FetchBodies } from "./search/index.ts";
import { createPrewarm } from "./search/prewarm.ts";
import { ErrorBoundary } from "./shell/ErrorBoundary.tsx";
import { Shell, useShell } from "./shell/Shell.tsx";
import {
  StorePoolProvider,
  StoreProvider,
  useContent,
  useStore,
  useStorePool,
  useStoreStatus,
  useSyncProgress,
} from "./store/index.ts";
import {
  type CurrentWorkspace,
  FIXTURE_WORKSPACE,
  pickAccount,
  useWorkspace,
  WorkspaceProvider,
  workspaceOf,
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
  // What became of the Agent's calendar drafts, in the Cache's meta table so a reload keeps it.
  const draftMemory = useMemo<DraftMemory>(
    () => ({
      async get(id) {
        const rows = await store
          .query<{ value: string }>("select value from meta where key = ?", [
            `calendar_draft:${id}`,
          ])
          .catch(() => []);
        return (rows[0]?.value as DraftStatus | "seen" | undefined) ?? null;
      },
      async set(id, status) {
        await store
          .write([
            {
              sql: "insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
              params: [`calendar_draft:${id}`, status],
            },
          ])
          .catch(() => {});
      },
    }),
    [store],
  );
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
      // The browser dev server has no Server: a fixture week of two Accounts' calendars.
      browser
        ? import("./screens/calendar/fixture.ts").then((fx) =>
            fx.devCalendar(new Date(), new URLSearchParams(location.search).get("calstate")),
          )
        : createStoreCalendar(store, shell.api, {
            otherAccounts: () => settingsRef.current["calendar.other_accounts"],
          }),
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
      draftMemory={draftMemory}
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
 * The gate below, and beside it "Your inbox is ready" once per Account
 * (first-sync/ready.ts): a note in the window while it is in front, a
 * desktop notification otherwise.
 */
function WorkspaceGate() {
  const shell = useShell();
  // "Your inbox is ready", once per Account: a note here while the window is in front.
  const [note, setNote] = useState<ReadyNotice | null>(null);
  useInboxReady(
    {
      list: () => shell.api.accounts.list().then((r) => r.accounts),
      read: (id) => shell.api.accounts.sync(id).then((r) => r.progress),
      settings: shell.settings,
      record: (announced) => void shell.set("sync.first_run_announced", announced),
      notify: (title, body) => platformNotifier.notify(title, body),
      note: setNote,
      inFront: windowInFront,
    },
    shell.server !== null,
  );
  return (
    <>
      <Gate />
      {note ? (
        <Toast
          key={note.accountId}
          className="ready-note"
          text={`${note.title}. ${note.body}`}
          undoLabel=""
          undoKey=""
          ms={shell.settings["notifications.note_ms"]}
          onExpire={() => setNote(null)}
        />
      ) : null}
    </>
  );
}

/**
 * Picks the Workspace: the Account workspace.current names (else the first) in the app, the design
 * fixture's on the browser dev server (no Server there). In the app nothing
 * renders until the Sidecar (or the Cloud) answers, so the fixture Workspace
 * never opens a Cache there. With a Server and no Account yet, the Accounts
 * screen is the whole app until one is connected. Once one is, the first sync
 * screen stands in for the app until the Inbox is fetched (FirstSync.tsx);
 * the Accounts keep being asked for meanwhile, so an Account removed from
 * that screen's Settings takes the gate back to the Accounts screen, and one
 * added there shows in its switcher.
 */
function Gate(): ReactNode {
  const shell = useShell();
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  const server = shell.server;
  const pollMs = shell.settings["server.first_run_poll_seconds"] * 1000;
  const appOpen = useRef(false);
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
          if (r.accounts.length === 0 || !appOpen.current) timer = setTimeout(tick, pollMs);
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

  // The workspace switcher writes workspace.current; the Account it names opens here.
  const picked = pickAccount(accounts, shell.settings["workspace.current"]);

  // Every account's saved mail open and syncing in the background: switching is
  // instant and new mail is already there (sync.warm_workspaces).
  const pool = useStorePool();
  const warm = shell.settings["sync.warm_workspaces"];
  const workspaceIds = (accounts ?? []).map((a) => a.workspaceId).join(",");
  useEffect(() => {
    if (!pool || !server || !warm || !workspaceIds) return;
    pool.warm(workspaceIds.split(","));
  }, [pool, server, warm, workspaceIds]);

  // New mail in any account, told once it lands in that account's saved mail.
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  const currentRef = useRef(picked?.workspaceId);
  currentRef.current = picked?.workspaceId;
  const settingsRef = useRef(shell.settings);
  settingsRef.current = shell.settings;
  useEffect(() => {
    if (!pool) return;
    return pool.onNewMessages((workspaceId, messages) => {
      const store = pool.get(workspaceId)?.store;
      const address = accountsRef.current?.find((a) => a.workspaceId === workspaceId)?.address;
      if (!store || address === undefined) return;
      // The window in front, on this account: the list shows it, nothing pops up.
      if (windowInFront() && currentRef.current === workspaceId) return;
      void newMailNotice({
        workspaceId,
        address,
        messages,
        store,
        settings: settingsRef.current,
        now: new Date(),
      })
        .then((notice) => {
          if (notice) void platformNotifier.notify(notice.title, notice.body).catch(() => {});
        })
        .catch(() => {});
    });
  }, [pool]);
  const pickedId = picked?.id;
  const pickedWorkspace = picked?.workspaceId;
  const pickedAddress = picked?.address;
  // Keyed on the values, so a poll that answers the same Account keeps the same object.
  const current = useMemo<CurrentWorkspace | null>(() => {
    if (shell.host === "browser" && !server) return FIXTURE_WORKSPACE;
    return pickedId && pickedWorkspace && pickedAddress !== undefined
      ? workspaceOf({ id: pickedId, workspaceId: pickedWorkspace, address: pickedAddress })
      : null;
  }, [shell.host, server, pickedId, pickedWorkspace, pickedAddress]);

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
  // The dev server's first sync screen over fixture progress (no Server to read).
  if (shell.host === "browser" && !server) {
    const q = new URLSearchParams(location.search);
    if (q.get("screen") === "first-sync") return <FirstSyncFixture state={q.get("state")} />;
  }
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
  const app = (
    <WorkspaceProvider key={current.id} value={current}>
      <StoreProvider
        workspaceId={current.id}
        fallback={
          <div className="store-state" role="status">
            <span className="live" />
            {shell.settings["strings.store.opening"].replace("{address}", current.address)}
          </div>
        }
        failed={(message, retry) => (
          <div className="store-state failed" role="alert">
            <b>{shell.settings["strings.store.failed"].replace("{address}", current.address)}</b>
            <span className="crash-detail">{message}</span>
            <div className="crash-actions">
              <Btn sm onClick={retry}>
                {shell.settings["strings.crash.retry"]}
              </Btn>
              <Btn sm primary onClick={() => window.location.reload()}>
                {shell.settings["strings.crash.reload"]}
              </Btn>
            </div>
          </div>
        )}
      >
        <Root />
      </StoreProvider>
    </WorkspaceProvider>
  );
  // The fixture Workspace has no Server to read a first sync from.
  if (!picked) return app;
  return (
    <FirstSyncGate
      key={picked.id}
      account={{ id: picked.id, address: picked.address, provider: picked.provider }}
      accounts={accounts ?? undefined}
      onOpen={() => {
        appOpen.current = true;
      }}
    >
      {app}
    </FirstSyncGate>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <ErrorBoundary area="app">
      <Shell>
        <StorePoolProvider>
          <WorkspaceGate />
        </StorePoolProvider>
      </Shell>
    </ErrorBoundary>
  </StrictMode>,
);
