// The Shell owns settings resolution, layout knobs, theming and the server connection
// (ADR 0001, ADR 0004, ADR 0009). It merges three layers, defaults under Server settings
// under the Config file, applies the result to the document root, and is the only path
// screens use to read or change a Setting.

import {
  type ConfigWarning,
  type Density,
  type Layout,
  type PartialSettings,
  type SettingKey,
  type Settings,
  type ThemeMode,
  defaultSettings,
  parseConfig,
  resolveSettings,
  settingScope,
  validateSetting,
} from "@monday/shared";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createApi, type Api, type ServerTarget } from "../platform/api.ts";
import { platform, type ConfigFile, type SidecarInfo } from "../platform/tauri.ts";

export interface ConfigState {
  file: ConfigFile | null;
  /** Values from the last good parse. A syntax error keeps these (ADR 0001). */
  values: PartialSettings;
  warnings: ConfigWarning[];
  error: { line: number | null; message: string } | null;
}

export interface ShellState {
  settings: Settings;
  pinned: ReadonlySet<SettingKey>;
  layout: Layout;
  density: Density;
  mode: ThemeMode;
  palette: string;
  config: ConfigState;
  sidecar: SidecarInfo | null;
  api: Api;
  /**
   * Change a Setting. Applies at once, then persists to the Server. Refuses a pinned
   * key: the file wins and only the user may edit it (ADR 0001).
   */
  set<K extends SettingKey>(key: K, value: Settings[K]): Promise<SetResult>;
}

export type SetResult =
  | { ok: true }
  | { ok: false; reason: "pinned" | "invalid" | "offline"; message: string };

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

function parseFile(file: ConfigFile, last: ConfigState): ConfigState {
  if (!file.exists || file.text.trim() === "") {
    return { file, values: {}, warnings: [], error: null };
  }
  const r = parseConfig(file.text);
  if (r.ok) return { file, values: r.values, warnings: r.warnings, error: null };
  return { ...last, file, error: { line: r.error.line, message: r.error.message } };
}

export function Shell({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ConfigState>({
    file: null,
    values: {},
    warnings: [],
    error: null,
  });
  const [server, setServer] = useState<PartialSettings>({});
  const [sidecar, setSidecar] = useState<SidecarInfo | null>(null);
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    let dispose: Array<() => void> = [];
    void platform().then(async (p) => {
      const first = await p.readConfig();
      setConfig((last) => parseFile(first, last));
      dispose.push(p.onConfigChanged((f) => setConfig((last) => parseFile(f, last))));
      const info = await p.sidecarInfo();
      if (info.running) setSidecar(info);
      dispose.push(p.onSidecarReady(setSidecar));
    });
    return () => {
      for (const d of dispose) d();
      dispose = [];
    };
  }, []);

  const api = useMemo(() => {
    const target = (): ServerTarget | null =>
      sidecar?.running
        ? { baseUrl: `http://127.0.0.1:${sidecar.port}`, token: sidecar.token }
        : null;
    return createApi(target);
  }, [sidecar]);

  useEffect(() => {
    if (!sidecar?.running) return;
    api.settings
      .all()
      .then(({ global, device }) => setServer({ ...global, ...device } as PartialSettings))
      .catch(() => {});
  }, [api, sidecar]);

  const resolved = useMemo(
    () => resolveSettings(config.values, server, defaultSettings()),
    [config.values, server],
  );
  const settings = resolved.settings;
  const layout: Layout = {
    nav: settings["layout.nav"],
    agent: settings["layout.agent"],
    list: settings["layout.list"],
  };
  const density = settings["appearance.density"];
  const mode = settings["appearance.mode"];
  const palette = settings["appearance.palette"];

  useEffect(() => {
    const r = document.documentElement;
    r.dataset.theme = resolveMode(mode);
    r.dataset.palette = palette;
    r.dataset.density = density;
    r.dataset.nav = layout.nav;
    r.dataset.agent = layout.agent;
    r.dataset.list = layout.list;
  }, [mode, palette, density, layout.nav, layout.agent, layout.list]);

  useEffect(() => {
    if (mode !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => {
      document.documentElement.dataset.theme = resolveMode(mode);
    };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [mode]);

  const set = useCallback(
    async <K extends SettingKey>(key: K, value: Settings[K]): Promise<SetResult> => {
      if (resolved.pinned.has(key)) {
        return {
          ok: false,
          reason: "pinned",
          message: `${key} is set in ${configRef.current.file?.path ?? "monday.toml"}`,
        };
      }
      const v = validateSetting(key, value);
      if (!v.ok) return { ok: false, reason: "invalid", message: v.error };
      setServer((s) => ({ ...s, [key]: value }));
      try {
        await api.settings.set(key, value, settingScope(key));
        return { ok: true };
      } catch (e) {
        return {
          ok: false,
          reason: "offline",
          message: e instanceof Error ? e.message : String(e),
        };
      }
    },
    [api, resolved.pinned],
  );

  const value = useMemo<ShellState>(
    () => ({
      settings,
      pinned: resolved.pinned,
      layout,
      density,
      mode,
      palette,
      config,
      sidecar,
      api,
      set,
    }),
    [
      settings,
      resolved.pinned,
      layout.nav,
      layout.agent,
      layout.list,
      density,
      mode,
      palette,
      config,
      sidecar,
      api,
      set,
    ],
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}
