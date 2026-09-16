import "@monday/ui/tokens.css";
import "@monday/ui/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { Shell } from "./shell/Shell.tsx";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Shell>
      <App />
    </Shell>
  </StrictMode>,
);
