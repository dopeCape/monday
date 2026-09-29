// A desktop notification posted by the Sidecar itself while monday's window
// is closed (ADR 0013): notify-send (org.freedesktop.Notifications) on Linux,
// osascript's display notification on macOS, a PowerShell balloon on Windows
// as a best effort. The command is built by a pure function so its quoting is
// tested; posting spawns it without a shell, so no text reaches one.
// Entry-only (Node's child_process).

import { spawn } from "node:child_process";

/** Titles longer than this are cut; bodies get twice as much (as the app's notify.rs does). */
export const TITLE_CHARS = 80;

export function trimForNotification(text: string, max: number): string {
  const t = text.trim();
  if ([...t].length <= max) return t;
  return `${[...t].slice(0, Math.max(0, max - 3)).join("")}...`;
}

export interface NotifyCommand {
  command: string;
  args: string[];
}

/** AppleScript string literal: backslashes and quotes escaped. */
function appleScriptString(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** PowerShell single-quoted literal: quotes doubled. */
function psString(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/** The command that shows one notification on this platform; null where there is none. */
export function notifyCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
): NotifyCommand | null {
  const t = trimForNotification(title, TITLE_CHARS);
  const b = trimForNotification(body, TITLE_CHARS * 2);
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    // "--" ends the options, so a title that starts with "-" is still the title.
    return { command: "notify-send", args: ["--app-name=monday", "--", t, b] };
  }
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: [
        "-e",
        `display notification ${appleScriptString(b)} with title ${appleScriptString(t)}`,
      ],
    };
  }
  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$n = New-Object System.Windows.Forms.NotifyIcon",
      "$n.Icon = [System.Drawing.SystemIcons]::Information",
      `$n.BalloonTipTitle = ${psString(t)}`,
      `$n.BalloonTipText = ${psString(b)}`,
      "$n.Visible = $true",
      "$n.ShowBalloonTip(8000)",
      "Start-Sleep -Seconds 9",
      "$n.Dispose()",
    ].join("; ");
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    };
  }
  return null;
}

export type Spawner = (command: string, args: string[]) => Promise<void>;

const spawnDetached: Spawner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 || code === null ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });

/** Posts through the platform's command; the Sidecar logs a failure and carries on. */
export function createDesktopNotifier(
  platform: NodeJS.Platform = process.platform,
  run: Spawner = spawnDetached,
): (notice: { title: string; body: string }) => Promise<void> {
  return async ({ title, body }) => {
    const cmd = notifyCommand(platform, title, body);
    if (!cmd) return;
    await run(cmd.command, cmd.args);
  };
}
