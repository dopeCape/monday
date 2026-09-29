// Export and Import as files, on request only (docs/spec/templates.md, "Files,
// on request only"): Export writes a folder of Markdown files in Downloads
// (in the browser, each file downloads); Import reads the files the user
// picks. Nothing runs by itself and nothing watches the folder.

import type { TemplateFile } from "@monday/shared";
import { platform } from "../platform/tauri.ts";

/** Where Export writes, inside Downloads: "monday-templates-2026-09-29". */
export function exportFolderName(now: Date): string {
  return `monday-templates-${now.toISOString().slice(0, 10)}`;
}

/** Writes the files; returns the folder they went to (or "Downloads" in the browser). */
export async function saveTemplateFiles(
  files: readonly TemplateFile[],
  now: Date,
): Promise<string> {
  const folder = exportFolderName(now);
  const p = await platform();
  if (p.isTauri) {
    const [{ mkdir, writeTextFile, BaseDirectory }, { downloadDir, join }] = await Promise.all([
      import("@tauri-apps/plugin-fs"),
      import("@tauri-apps/api/path"),
    ]);
    await mkdir(folder, { baseDir: BaseDirectory.Download, recursive: true });
    for (const f of files) {
      const safe = f.name.replace(/[/\\:*?"<>|]/g, "_");
      await writeTextFile(`${folder}/${safe}`, f.content, { baseDir: BaseDirectory.Download });
    }
    return join(await downloadDir(), folder);
  }
  for (const f of files) {
    const url = URL.createObjectURL(new Blob([f.content], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = f.name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return "Downloads";
}

/** The picked files as name and text, Markdown only. */
export async function readTemplateFiles(files: readonly File[]): Promise<TemplateFile[]> {
  const md = files.filter((f) => /\.(md|markdown)$/i.test(f.name));
  return Promise.all(md.map(async (f) => ({ name: f.name, content: await f.text() })));
}
