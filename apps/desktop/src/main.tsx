import "@monday/ui/tokens.css";
import "@monday/ui/app.css";
import { account, draftGhost, draftNote, workspace } from "@monday/ui/fixtures";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { platform } from "./platform/tauri.ts";
import { createStoreComposer, type StoreComposer } from "./screens/compose/store-composer.ts";
import { createStoreInbox, type StoreInbox } from "./screens/inbox/store-inbox.ts";
import { Shell, useShell } from "./shell/Shell.tsx";
import {
  StoreProvider,
  useContent,
  useStore,
  useStoreStatus,
  useSyncProgress,
} from "./store/index.ts";

/** The app over the Store: the inbox and compose seams, the workspace dot and the sync line. */
function Root() {
  const store = useStore();
  const content = useContent();
  const shell = useShell();
  const settingsRef = useRef(shell.settings);
  settingsRef.current = shell.settings;
  const status = useStoreStatus();
  const progress = useSyncProgress();
  const [seams, setSeams] = useState<{ inbox: StoreInbox; composer: StoreComposer } | null>(null);
  useEffect(() => {
    if (!content) return;
    let closed = false;
    let opened: { inbox: StoreInbox; composer: StoreComposer } | null = null;
    void Promise.all([
      createStoreInbox(store, {
        content,
        remoteImages: () => settingsRef.current["reader.load_remote_images"],
        log: (m) => console.warn(`[reader] ${m}`),
      }),
      platform().then((p) =>
        createStoreComposer(store, content, {
          address: account.address,
          // The browser dev server shows the design fixture's suggestion; the Agent's arrive in slice 14.
          suggestions: p.isTauri ? undefined : { d1: { ghost: draftGhost, note: draftNote } },
        }),
      ),
    ]).then(([inbox, composer]) => {
      if (closed) {
        inbox.close();
        composer.close();
      } else {
        opened = { inbox, composer };
        setSeams(opened);
      }
    });
    return () => {
      closed = true;
      opened?.inbox.close();
      opened?.composer.close();
    };
  }, [store, content]);
  if (!seams) return null;
  return (
    <App
      inbox={seams.inbox}
      composer={seams.composer}
      online={status === "online" || status === "syncing"}
      syncing={progress}
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
