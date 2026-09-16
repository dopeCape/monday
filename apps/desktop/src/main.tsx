import "@monday/ui/tokens.css";
import "@monday/ui/app.css";
import { account, workspace } from "@monday/ui/fixtures";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { platform } from "./platform/tauri.ts";
import { createStoreInbox, type StoreInbox } from "./screens/inbox/store-inbox.ts";
import { createSearch, type FetchBodies } from "./search/index.ts";
import { createPrewarm } from "./search/prewarm.ts";
import { Shell, useShell } from "./shell/Shell.tsx";
import { StoreProvider, useStore, useStoreStatus, useSyncProgress } from "./store/index.ts";

/** The app over the Store: the inbox seam, the workspace dot, the sync line, search and the pre-warm Job. */
function Root() {
  const store = useStore();
  const shell = useShell();
  const status = useStoreStatus();
  const progress = useSyncProgress();
  const [inbox, setInbox] = useState<StoreInbox | null>(null);
  const settingsRef = useRef(shell.settings);
  settingsRef.current = shell.settings;

  // The bulk body route: "search older mail" and the pre-warm Job share it.
  const fetchBodies = useMemo<FetchBodies>(
    () => (workspaceId, range) => shell.api.messages.bodies(workspaceId, range),
    [shell.api],
  );

  const search = useMemo(
    () =>
      createSearch({
        sources: () => [{ store, account: account.address }],
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
    let closed = false;
    let opened: StoreInbox | null = null;
    void createStoreInbox(store).then((i) => {
      if (closed) i.close();
      else {
        opened = i;
        setInbox(i);
      }
    });
    return () => {
      closed = true;
      opened?.close();
    };
  }, [store]);
  if (!inbox) return null;
  return (
    <App
      inbox={inbox}
      online={status === "online" || status === "syncing"}
      syncing={progress}
      search={search}
    />
  );
}

// One Workspace at a time (CONTEXT.md). Until accounts arrive with the
// Providers the fixture Workspace names the Cache file.
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Shell>
      <StoreProvider workspaceId={workspace.id}>
        <Root />
      </StoreProvider>
    </Shell>
  </StrictMode>,
);
