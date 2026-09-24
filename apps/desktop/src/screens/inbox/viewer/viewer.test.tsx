/// <reference types="bun-types" />
// The attachment viewer through the DOM: the viewer each file type opens in,
// text, CSV and zip rendered inside monday, a type with no preview and a file
// over the limit saying so with Download, the arrows moving between the
// message's attachments, and Escape closing.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { dom } from "@monday/ui/test-dom";
import { zipSync } from "fflate";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { AttachmentViewer, type ViewerFile, type ViewerStrings } from "./AttachmentViewer.tsx";
import { viewerKind } from "./kind.ts";

let createRoot: Awaited<ReturnType<typeof dom>>["createRoot"];
beforeAll(async () => {
  ({ createRoot } = await dom());
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const strings: ViewerStrings = {
  close: "Close",
  download: "Download",
  previous: "Previous attachment",
  next: "Next attachment",
  loading: "Opening {name}",
  noPreview: "monday can't show {name} here.",
  tooLarge: "{name} is {size}, over the preview limit.",
  failed: "{name} could not be shown: {message}",
  rowsMore: "Showing the first {n} of {total} rows.",
  pageOf: "{total} pages",
  zipFiles: "{n} files",
  from: "From",
  to: "To",
  date: "Date",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  label: "Attachment {name}",
};

const enc = new TextEncoder();

describe("the viewer a file opens in", () => {
  test("by media type, and by extension when the type is generic", () => {
    expect(viewerKind("report.pdf", "application/octet-stream")).toBe("pdf");
    expect(viewerKind("a", "application/pdf")).toBe("pdf");
    expect(viewerKind("notes.docx", "application/octet-stream")).toBe("docx");
    expect(
      viewerKind("q3.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ).toBe("sheet");
    expect(viewerKind("list.csv", "text/plain")).toBe("csv");
    expect(viewerKind("photo.JPG", "application/octet-stream")).toBe("image");
    expect(viewerKind("call.m4a", "")).toBe("audio");
    expect(viewerKind("demo.mov", "")).toBe("video");
    expect(viewerKind("src.zip", "application/zip")).toBe("zip");
    expect(viewerKind("fwd.eml", "message/rfc822")).toBe("email");
    expect(viewerKind("README.md", "")).toBe("markdown");
    expect(viewerKind("config.yaml", "")).toBe("text");
    expect(viewerKind("invite.ics", "text/calendar")).toBe("text");
    expect(viewerKind("deck.pptx", "application/octet-stream")).toBe("none");
  });
});

async function mount(
  files: ViewerFile[],
  contents: Record<string, Uint8Array>,
  opts: { maxBytes?: number } = {},
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const state = { index: 0, closed: false, downloaded: [] as string[] };
  function Harness() {
    const [index, setIndex] = useState(0);
    state.index = index;
    return (
      <AttachmentViewer
        files={files}
        index={index}
        onIndex={setIndex}
        onClose={() => {
          state.closed = true;
        }}
        load={async (id) => ({ bytes: contents[id] ?? new Uint8Array(), mediaType: "" })}
        onDownload={(f) => state.downloaded.push(f.id)}
        strings={strings}
        maxBytes={opts.maxBytes ?? 50 * 1024 * 1024}
        maxRows={2}
      />
    );
  }
  const r = root;
  await act(async () => r.render(<Harness />));
  await act(async () => Bun.sleep(30));
  return state;
}

const q = (s: string) => document.querySelector(s);
const body = () => q(".viewer-body")?.textContent ?? "";

describe("the attachment viewer", () => {
  test("shows text, a CSV as a table cut to the row limit, and a zip's file list", async () => {
    const zip = zipSync({ "a.txt": enc.encode("hello"), "dir/b.txt": enc.encode("world!") });
    const files: ViewerFile[] = [
      { id: "t", name: "notes.txt", mediaType: "text/plain", size: 11 },
      { id: "c", name: "people.csv", mediaType: "text/csv", size: 30 },
      { id: "z", name: "bundle.zip", mediaType: "application/zip", size: zip.length },
    ];
    const state = await mount(files, {
      t: enc.encode("line one\nline two"),
      c: enc.encode("name,city\nAoife,Dublin\nKenji,Osaka\nSam,Leeds"),
      z: zip,
    });
    expect(q(".viewer-title b")?.textContent).toBe("notes.txt");
    expect(q(".viewer-text")?.textContent).toBe("line one\nline two");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    await act(async () => Bun.sleep(50));
    expect(state.index).toBe(1);
    const headers = [...document.querySelectorAll(".viewer-table th")].map((c) => c.textContent);
    expect(headers).toEqual(["name", "city"]);
    // maxRows 2: the header and one row, then the note.
    expect(document.querySelectorAll(".viewer-table tbody tr")).toHaveLength(1);
    expect(body()).toContain("Showing the first 2 of 4 rows.");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    await act(async () => Bun.sleep(50));
    expect(body()).toContain("2 files");
    expect(
      [...document.querySelectorAll(".viewer-zip li span:first-child")].map((s) => s.textContent),
    ).toEqual(["a.txt", "dir/b.txt"]);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(state.closed).toBe(true);
  });

  test("a type with no preview, and a file over the limit, say so and offer Download", async () => {
    const files: ViewerFile[] = [
      { id: "p", name: "deck.pptx", mediaType: "application/octet-stream", size: 1000 },
      { id: "big", name: "huge.txt", mediaType: "text/plain", size: 5000 },
    ];
    const state = await mount(files, {}, { maxBytes: 4000 });
    expect(body()).toContain("monday can't show deck.pptx here.");
    const download = [...document.querySelectorAll(".viewer-head button")].find((b) =>
      b.textContent?.includes("Download"),
    );
    await act(async () => (download as HTMLButtonElement).click());
    expect(state.downloaded).toEqual(["p"]);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    await act(async () => Bun.sleep(30));
    expect(body()).toContain("huge.txt is");
    expect(body()).toContain("over the preview limit.");
  });
});
