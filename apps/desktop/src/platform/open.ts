// Leaving the webview: links open in the system browser through the opener
// plugin, downloads land in the Downloads folder and open from there. In the
// browser dev server both fall back to window.open and an object URL.

import { platform } from "./tauri.ts";

/** Opens an http, https or mailto link outside the app. Anything else is ignored. */
export async function openExternal(href: string): Promise<void> {
  if (!/^(https?:|mailto:)/i.test(href)) return;
  const p = await platform();
  if (p.isTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(href);
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}

/** Saves bytes as a file the user can open: the Downloads folder in Tauri, a browser download otherwise. */
export async function saveDownload(
  name: string,
  bytes: Uint8Array,
  mediaType: string,
): Promise<void> {
  const p = await platform();
  if (p.isTauri) {
    const [{ writeFile, BaseDirectory }, { openPath }, { downloadDir, join }] = await Promise.all([
      import("@tauri-apps/plugin-fs"),
      import("@tauri-apps/plugin-opener"),
      import("@tauri-apps/api/path"),
    ]);
    const safe = name.replace(/[/\\:*?"<>|]/g, "_") || "attachment";
    await writeFile(safe, bytes, { baseDir: BaseDirectory.Download });
    await openPath(await join(await downloadDir(), safe));
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
