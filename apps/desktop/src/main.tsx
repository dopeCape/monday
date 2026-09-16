import "@monday/ui/tokens.css";
import "@monday/ui/app.css";
import { workspace } from "@monday/ui/fixtures";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { Shell } from "./shell/Shell.tsx";
import { StoreProvider } from "./store/index.ts";

// One Workspace at a time (CONTEXT.md). Until accounts arrive with slice 5's
// Providers the fixture Workspace names the Cache file.
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Shell>
      <StoreProvider workspaceId={workspace.id}>
        <App />
      </StoreProvider>
    </Shell>
  </StrictMode>,
);
