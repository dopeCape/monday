import "@monday/ui/tokens.css";
import "@monday/ui/app.css";
import { workspace } from "@monday/ui/fixtures";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { createStoreInbox, type StoreInbox } from "./screens/inbox/store-inbox.ts";
import { Shell } from "./shell/Shell.tsx";
import { StoreProvider, useStore, useStoreStatus, useSyncProgress } from "./store/index.ts";

/** The app over the Store: the inbox seam, the workspace dot and the sync line. */
function Root() {
  const store = useStore();
  const status = useStoreStatus();
  const progress = useSyncProgress();
  const [inbox, setInbox] = useState<StoreInbox | null>(null);
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
    <App inbox={inbox} online={status === "online" || status === "syncing"} syncing={progress} />
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
