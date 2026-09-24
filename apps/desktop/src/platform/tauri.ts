// The seam between the webview and Rust. Everything the app needs from the host
// goes through this one module, so tests and the browser dev server can fake it.

import type { Process, ProcessRunner, SpawnOptions } from "../agent/runtimes/process.ts";

export type { Process, ProcessRunner, SpawnOptions } from "../agent/runtimes/process.ts";

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

/** What the host knows about the connection, for the pre-warm Job (ADR 0011). */
export interface NetworkInfo {
  online: boolean;
  /** True on a connection the OS marks as metered (a hotspot, a capped plan); unknown reads as false. */
  metered: boolean;
}

/** What the host knows about power, for the pre-warm Job (ADR 0011). */
export interface PowerInfo {
  /** True on mains or when there is no battery at all (a desktop). */
  mains: boolean;
  /** Charge from 0 to 1, or null without a battery. */
  level: number | null;
}

export interface Platform {
  readConfig(): Promise<ConfigFile>;
  /** Only after the user explicitly asked (ADR 0001). */
  writeConfig(text: string): Promise<void>;
  onConfigChanged(cb: (file: ConfigFile) => void): () => void;
  /**
   * Keeps the appearance.webview_memory_mb Setting where the shell reads it
   * before the window starts (the next launch). Absent outside the desktop app.
   */
  saveWebviewMemory?(mb: number): Promise<boolean>;
  /**
   * The palette file `appearance.palette` names (a token TOML or a base16
   * YAML): `~` expands, a relative path is under the config directory. Read
   * only, never written; `exists` is false when there is no such file.
   */
  readPaletteFile(path: string): Promise<ConfigFile>;
  secretGet(key: string): Promise<string | null>;
  secretSet(key: string, value: string): Promise<void>;
  secretDelete(key: string): Promise<void>;
  sidecarInfo(): Promise<SidecarInfo>;
  onSidecarReady(cb: (info: SidecarInfo) => void): () => void;
  /** The Sidecar could not start (no Postgres, a bad data directory); the message is the host's. */
  onSidecarFailed(cb: (message: string) => void): () => void;
  /** Opens a URL in the system browser (the OAuth wizards, deep links into consoles). */
  openExternal(url: string): Promise<void>;
  network(): Promise<NetworkInfo>;
  power(): Promise<PowerInfo>;
  /**
   * The recovery file text: one line saying what it is, then the root key from
   * this Device's keychain (ADR 0005). Rejects when the keychain is unavailable.
   */
  recoveryFile(): Promise<string>;
  /** Replaces the root key from a recovery file; a new Device joining an existing Server. */
  importRecoveryKey(text: string): Promise<void>;
  /**
   * A desktop notification (a calendar reminder, a Workflow failure) through
   * the host: the notification plugin in the app, the web Notification API in
   * a browser. The caller has already checked the notifications.* Settings.
   */
  notify(title: string, body: string): Promise<void>;
  /**
   * Spawns one of the Local runtime CLIs (CONTEXT.md, Local runtime) through
   * the shell plugin. `command` is a scope name from the capability
   * (`claude`, `codex`, `opencode` and their detection variants), never a
   * free path; a path override from Settings goes in front of PATH.
   */
  spawn: ProcessRunner;
  isTauri: boolean;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function tauriPlatform(): Promise<Platform> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  const { Command } = await import("@tauri-apps/plugin-shell");
  const spawn: ProcessRunner = async (command, options: SpawnOptions): Promise<Process> => {
    const env: Record<string, string> = { ...(options.env ?? {}) };
    if (options.pathPrefix) {
      const separator = navigator.platform.startsWith("Win") ? ";" : ":";
      env.PATH = `${options.pathPrefix}${separator}${await invoke<string>("env_path")}`;
    }
    const cmd = Command.create(command, [...options.args], {
      env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    const stdout = new Set<(line: string) => void>();
    const stderr = new Set<(line: string) => void>();
    const strip = (line: string) => line.replace(/\r?\n$/, "");
    cmd.stdout.on("data", (line) => {
      for (const l of stdout) l(strip(line));
    });
    cmd.stderr.on("data", (line) => {
      for (const l of stderr) l(strip(line));
    });
    const exited = new Promise<number | null>((resolve) => {
      cmd.on("close", (payload) => resolve(payload.code));
      cmd.on("error", () => resolve(null));
    });
    const child = await cmd.spawn();
    return {
      pid: child.pid,
      exited,
      onStdout: (listener) => {
        stdout.add(listener);
        return () => stdout.delete(listener);
      },
      onStderr: (listener) => {
        stderr.add(listener);
        return () => stderr.delete(listener);
      },
      write: (text) => child.write(text),
      kill: () => child.kill(),
    };
  };
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
    readPaletteFile: (path) => invoke<ConfigFile>("read_palette_file", { path }),
    secretGet: (key) => invoke<string | null>("secret_get", { key }),
    secretSet: (key, value) => invoke("secret_set", { key, value }),
    secretDelete: (key) => invoke("secret_delete", { key }),
    sidecarInfo: () => invoke<SidecarInfo>("sidecar_info"),
    onSidecarReady: (cb) => sub<SidecarInfo>("sidecar:ready", cb),
    onSidecarFailed: (cb) => sub<string>("sidecar:failed", cb),
    openExternal: (url) => openUrl(url),
    network: () => invoke<NetworkInfo>("network_info"),
    power: () => invoke<PowerInfo>("power_info"),
    recoveryFile: () => invoke<string>("recovery_file"),
    importRecoveryKey: (text) => invoke("import_recovery_key", { text }),
    notify: (title, body) => invoke("notify", { title, body }),
    saveWebviewMemory: (mb) => invoke<boolean>("webview_memory_save", { mb }),
    spawn,
  };
}

export interface FakePlatformOptions {
  /** The fake's connection; `?metered=1` in the dev server flips it. */
  network?: NetworkInfo;
  /** The fake's power; `?battery=1` in the dev server flips it. */
  power?: PowerInfo;
  /** The fake's root key, base64 of 32 bytes; null plays an unavailable keychain. */
  rootKey?: string | null;
  /** The processes the fake spawns; none by default, so every CLI reads as not installed. */
  spawn?: ProcessRunner;
  /** Receives what the fake would have shown as a desktop notification. */
  notified?: (title: string, body: string) => void;
  /** Palette files by path, as `appearance.palette` would name them. */
  files?: Record<string, string>;
}

/** The recovery file the Rust side writes, over a base64 key (src-tauri/src/rootkey.rs). */
/** Where the browser dev server remembers a demo server's target (scripts/demo.ts). */
export const DEMO_TARGET_KEY = "monday.demo.target";

function demoSecret(key: string): string | null {
  if (key !== "server.cloud" || typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(DEMO_TARGET_KEY);
  } catch {
    return null;
  }
}

function forgetDemoSecret(key: string): void {
  if (key !== "server.cloud" || typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(DEMO_TARGET_KEY);
  } catch {}
}

/**
 * On the browser dev server, `?demo=<server url>&token=<token>` (printed by
 * scripts/demo.ts) connects to that server instead of the design fixture, and
 * remembers it; `?demo=off` forgets it. Returns true when a demo server is set.
 */
export function adoptDemoTarget(): boolean {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return false;
  const q = new URLSearchParams(window.location.search);
  const demo = q.get("demo");
  try {
    if (demo === "off") {
      localStorage.removeItem(DEMO_TARGET_KEY);
    } else if (demo && q.get("token")) {
      localStorage.setItem(
        DEMO_TARGET_KEY,
        JSON.stringify({
          baseUrl: demo.replace(/\/+$/, ""),
          token: q.get("token"),
          deviceId: "demo-browser",
        }),
      );
    }
    if (demo) {
      q.delete("demo");
      q.delete("token");
      const rest = q.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
    }
    return localStorage.getItem(DEMO_TARGET_KEY) !== null;
  } catch {
    return false;
  }
}

export function recoveryFileText(key: string): string {
  return `monday recovery key. This unlocks every message on your server. Keep it private; without it, a new install cannot read your mail.\n${key}\n`;
}

/** The key inside a recovery file, or null when the text is not one. */
export function recoveryKeyOf(text: string): string | null {
  const key = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .at(-1);
  if (!key || !/^[A-Za-z0-9+/]+=*$/.test(key)) return null;
  try {
    return atob(key).length === 32 ? key : null;
  } catch {
    return null;
  }
}

/** Browser dev server and tests: in-memory config, no sidecar, unmetered and on mains unless told otherwise. */
export function fakePlatform(initialConfig = "", options: FakePlatformOptions = {}): Platform {
  let text = initialConfig;
  const network = options.network ?? { online: true, metered: false };
  const power = options.power ?? { mains: true, level: null };
  let rootKey =
    options.rootKey === undefined ? btoa(String.fromCharCode(...FAKE_ROOT_KEY)) : options.rootKey;
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
    readPaletteFile: async (path) => {
      const content = options.files?.[path];
      return { path, exists: content !== undefined, text: content ?? "" };
    },
    // The browser dev server keeps its secrets for the tab's life; a demo
    // server's target (scripts/demo.ts) is kept in localStorage so a reload stays in it.
    secretGet: async (k) => secrets.get(k) ?? demoSecret(k),
    secretSet: async (k, v) => {
      secrets.set(k, v);
    },
    secretDelete: async (k) => {
      secrets.delete(k);
      forgetDemoSecret(k);
    },
    sidecarInfo: async () => ({ port: 0, token: "", running: false }),
    onSidecarReady: () => () => {},
    onSidecarFailed: () => () => {},
    openExternal: async (url) => {
      if (typeof window !== "undefined") window.open(url, "_blank", "noopener");
    },
    network: async () => ({ ...network }),
    power: async () => ({ ...power }),
    recoveryFile: async () => {
      if (!rootKey) throw new Error("keychain unavailable");
      return recoveryFileText(rootKey);
    },
    importRecoveryKey: async (t) => {
      const key = recoveryKeyOf(t);
      if (!key) throw new Error("not a recovery key");
      rootKey = key;
    },
    notify: async (title, body) => {
      if (options.notified) {
        options.notified(title, body);
        return;
      }
      await webNotify(title, body);
    },
    spawn:
      options.spawn ??
      (async (command) => {
        throw new Error(`${command}: command not found`);
      }),
  };
}

/** The web Notification API for a browser, asking once; silent where there is none. */
async function webNotify(title: string, body: string): Promise<void> {
  if (typeof Notification === "undefined") return;
  let permission = Notification.permission;
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission !== "granted") return;
  new Notification(title, { body });
}

/** Desktop notifications through whichever platform is running; the shape reminders take. */
export const platformNotifier = {
  async notify(title: string, body: string): Promise<void> {
    const p = await platform();
    await p.notify(title, body);
  },
};

/** A fixed 32-byte key so the browser dev server's recovery file is stable. */
const FAKE_ROOT_KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256);

let cached: Promise<Platform> | undefined;
export function platform(): Promise<Platform> {
  cached ??= inTauri()
    ? tauriPlatform()
    : Promise.resolve(fakePlatform(devConfig(), devConditions()));
  return cached;
}

/** Browser dev only: `?metered=1` and `?battery=1` put the fake on a hotspot or off mains. */
function devConditions(): FakePlatformOptions {
  if (typeof location === "undefined") return {};
  const q = new URLSearchParams(location.search);
  return {
    network: { online: true, metered: q.get("metered") === "1" },
    power: { mains: q.get("battery") !== "1", level: q.get("battery") === "1" ? 0.5 : null },
  };
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
