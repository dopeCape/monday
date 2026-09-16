// Placeholder until packages/ui lands: proves the Shell, the platform seam and the
// sidecar connection end to end. Replaced by the real screens in the same slice.

import { useEffect, useState } from "react";
import { useShell } from "./shell/Shell.tsx";

export function App() {
  const shell = useShell();
  const [health, setHealth] = useState<string>("connecting");

  useEffect(() => {
    if (!shell.sidecar?.running) return;
    shell.api
      .health()
      .then((h) => setHealth(h.ok ? "ok" : "unhealthy"))
      .catch((e: Error) => setHealth(e.message));
  }, [shell.sidecar, shell.api]);

  return (
    <div className="app" style={{ display: "grid", placeItems: "center" }}>
      <div style={{ maxWidth: 480, fontSize: "var(--fs-md)", color: "var(--fg-muted)" }}>
        <p style={{ color: "var(--fg)", fontWeight: 600 }}>monday</p>
        <p>Config: {shell.config?.exists ? shell.config.path : "no file yet"}</p>
        <p>
          Sidecar:{" "}
          {shell.sidecar?.running ? `port ${shell.sidecar.port}, health ${health}` : "starting"}
        </p>
        <p>
          Layout: {shell.layout.nav} / {shell.layout.agent} / {shell.layout.list}, {shell.density},{" "}
          {shell.palette}
        </p>
      </div>
    </div>
  );
}
