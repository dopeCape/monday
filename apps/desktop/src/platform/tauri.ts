// The seam between the webview and Rust. Everything the app needs from the host
// goes through this one module, so tests and the browser dev server can fake it.

export interface ConfigFile {
  path: string;
  exists: boolean;
  text: string;
}

export interface SidecarInfo {
  port: number;
  token: string;
  running: boolean;
}

export interface Platform {
  readConfig(): Promise<ConfigFile>;
  /** Only after the user explicitly asked (ADR 0001). */
  writeConfig(text: string): Promise<void>;
  onConfigChanged(cb: (file: ConfigFile) => void): () => void;
  secretGet(key: string): Promise<string | null>;
  secretSet(key: string, value: string): Promise<void>;
  secretDelete(key: string): Promise<void>;
  sidecarInfo(): Promise<SidecarInfo>;
  onSidecarReady(cb: (info: SidecarInfo) => void): () => void;
  isTauri: boolean;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function tauriPlatform(): Promise<Platform> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const sub = <T>(name: string, cb: (p: T) => void) => {
    let un: (() => void) | undefined;
    let cancelled = false;
    void listen<T>(name, (e) => cb(e.payload)).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  };
  return {
    isTauri: true,
    readConfig: () => invoke<ConfigFile>("read_config"),
    writeConfig: (text) => invoke("write_config", { text }),
    onConfigChanged: (cb) => sub<ConfigFile>("config:changed", cb),
    secretGet: (key) => invoke<string | null>("secret_get", { key }),
    secretSet: (key, value) => invoke("secret_set", { key, value }),
    secretDelete: (key) => invoke("secret_delete", { key }),
    sidecarInfo: () => invoke<SidecarInfo>("sidecar_info"),
    onSidecarReady: (cb) => sub<SidecarInfo>("sidecar:ready", cb),
  };
}

/** Browser dev server and tests: in-memory config, no sidecar. */
export function fakePlatform(initialConfig = ""): Platform {
  let text = initialConfig;
  const listeners = new Set<(f: ConfigFile) => void>();
  const secrets = new Map<string, string>();
  const file = (): ConfigFile => ({
    path: "~/.config/monday/monday.toml",
    exists: text.length > 0,
    text,
  });
  return {
    isTauri: false,
    readConfig: async () => file(),
    writeConfig: async (t) => {
      text = t;
      for (const l of listeners) l(file());
    },
    onConfigChanged: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    secretGet: async (k) => secrets.get(k) ?? null,
    secretSet: async (k, v) => {
      secrets.set(k, v);
    },
    secretDelete: async (k) => {
      secrets.delete(k);
    },
    sidecarInfo: async () => ({ port: 0, token: "", running: false }),
    onSidecarReady: () => () => {},
  };
}

let cached: Promise<Platform> | undefined;
export function platform(): Promise<Platform> {
  cached ??= inTauri() ? tauriPlatform() : Promise.resolve(fakePlatform(devConfig()));
  return cached;
}

/** Browser dev only: `?config=<base64 toml>` seeds the fake platform's config file. */
function devConfig(): string {
  if (typeof location === "undefined") return "";
  const b64 = new URLSearchParams(location.search).get("config");
  if (!b64) return "";
  try {
    return decodeURIComponent(escape(atob(b64)));
  } catch {
    return "";
  }
}
