// The Shell owns layout knobs, views, theming and the server connection (ADR 0009).
// It reads settings from the Config file and the Server and applies them to the root;
// screens never touch either directly.

import { PRESETS, type Density, type Layout, type ThemeMode } from "@monday/shared";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createApi, type Api, type ServerTarget } from "../platform/api.ts";
import { platform, type ConfigFile, type SidecarInfo } from "../platform/tauri.ts";

export interface ShellState {
  mode: ThemeMode;
  palette: string;
  density: Density;
  layout: Layout;
  config: ConfigFile | null;
  sidecar: SidecarInfo | null;
  api: Api;
  set(patch: Partial<Pick<ShellState, "mode" | "palette" | "density" | "layout">>): void;
}

const ShellContext = createContext<ShellState | null>(null);

export function useShell(): ShellState {
  const s = useContext(ShellContext);
  if (!s) throw new Error("useShell outside Shell");
  return s;
}

function resolveMode(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function Shell({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>("system");
  const [palette, setPalette] = useState("graphite");
  const [density, setDensity] = useState<Density>("comfortable");
  const [layout, setLayout] = useState<Layout>(PRESETS.stream);
  const [config, setConfig] = useState<ConfigFile | null>(null);
  const [sidecar, setSidecar] = useState<SidecarInfo | null>(null);

  useEffect(() => {
    let dispose: Array<() => void> = [];
    void platform().then(async (p) => {
      setConfig(await p.readConfig());
      dispose.push(p.onConfigChanged(setConfig));
      const info = await p.sidecarInfo();
      if (info.running) setSidecar(info);
      dispose.push(p.onSidecarReady(setSidecar));
    });
    return () => {
      for (const d of dispose) d();
      dispose = [];
    };
  }, []);

  useEffect(() => {
    const r = document.documentElement;
    r.dataset.theme = resolveMode(mode);
    r.dataset.palette = palette;
    r.dataset.density = density;
    r.dataset.nav = layout.nav;
    r.dataset.agent = layout.agent;
    r.dataset.list = layout.list;
  }, [mode, palette, density, layout]);

  useEffect(() => {
    if (mode !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => {
      document.documentElement.dataset.theme = resolveMode(mode);
    };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [mode]);

  const api = useMemo(() => {
    const target = (): ServerTarget | null =>
      sidecar?.running ? { baseUrl: `http://127.0.0.1:${sidecar.port}`, token: sidecar.token } : null;
    return createApi(target);
  }, [sidecar]);

  const value = useMemo<ShellState>(
    () => ({
      mode,
      palette,
      density,
      layout,
      config,
      sidecar,
      api,
      set(patch) {
        if (patch.mode) setMode(patch.mode);
        if (patch.palette) setPalette(patch.palette);
        if (patch.density) setDensity(patch.density);
        if (patch.layout) setLayout(patch.layout);
      },
    }),
    [mode, palette, density, layout, config, sidecar, api],
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}
