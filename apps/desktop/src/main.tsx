import "@monday/ui/tokens.css";
import "@monday/ui/app.css";
import { account, draftGhost, draftNote, workspace } from "@monday/ui/fixtures";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { platform } from "./platform/tauri.ts";
import { createStoreComposer, type StoreComposer } from "./screens/compose/store-composer.ts";
import { createStoreInbox, type StoreInbox } from "./screens/inbox/store-inbox.ts";
import { createStoreRouting, type StoreRouting } from "./screens/routing/routing-data.ts";
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

/**
 * The app over the Store: the inbox and compose seams, the workspace dot, the
 * sync line, search and the pre-warm Job.
 */
function Root() {
  const store = useStore();
  const content = useContent();
  const shell = useShell();
  const settingsRef = useRef(shell.settings);
  settingsRef.current = shell.settings;
  const status = useStoreStatus();
  const progress = useSyncProgress();
  const [seams, setSeams] = useState<{
    inbox: StoreInbox;
    composer: StoreComposer;
    routing: StoreRouting;
  } | null>(null);

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
    if (!content) return;
    let closed = false;
    let opened: { inbox: StoreInbox; composer: StoreComposer; routing: StoreRouting } | null = null;
    let routingSeam: StoreRouting | null = null;
    void Promise.all([
      createStoreRouting(store).then((r) => {
        routingSeam = r;
        return r;
      }),
      createStoreInbox(store, {
        content,
        remoteImages: () => settingsRef.current["reader.load_remote_images"],
        level: () => settingsRef.current["ai.level"],
        // The Section rules run here, on the client, over the Cache (CONTEXT.md "Section rule").
        sections: {
          rules: () => settingsRef.current["sections.rules"],
          order: () => settingsRef.current["sections.order"],
          owner: account.address,
          groupNames: () =>
            Object.fromEntries((routingSeam?.groups() ?? []).map((g) => [g.id, g.name])),
        },
        log: (m) => console.warn(`[reader] ${m}`),
      }),
      platform().then((p) =>
        createStoreComposer(store, content, {
          address: account.address,
          // The browser dev server shows the design fixture's suggestion; the Agent's arrive in slice 14.
          suggestions: p.isTauri ? undefined : { d1: { ghost: draftGhost, note: draftNote } },
        }),
      ),
    ]).then(([routing, inbox, composer]) => {
      if (closed) {
        inbox.close();
        composer.close();
        routing.close();
      } else {
        opened = { inbox, composer, routing };
        setSeams(opened);
      }
    });
    return () => {
      closed = true;
      opened?.inbox.close();
      opened?.composer.close();
      opened?.routing.close();
    };
  }, [store, content]);

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
