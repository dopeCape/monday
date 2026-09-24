// PDF pages drawn onto canvases with pdf.js. Loaded only when a PDF is opened,
// so the app never pays for pdf.js otherwise; the worker is Vite's own URL.

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfHandle {
  pages: number;
  /** Draws page n (1-based) into a new canvas as wide as `width` CSS pixels. */
  render(n: number, width: number): Promise<HTMLCanvasElement>;
  destroy(): void;
}

export async function openPdf(bytes: Uint8Array): Promise<PdfHandle> {
  // pdf.js takes ownership of the buffer it is given, so it gets a copy.
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  return {
    pages: doc.numPages,
    async render(n, width) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const ratio = globalThis.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: (width / base.width) * ratio });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      // Only the width is set: the height follows the canvas's own ratio, so it scales down too.
      canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
      await page.render({ canvas, viewport }).promise;
      return canvas;
    },
    destroy() {
      // The loading task owns the worker; destroying it frees the document too.
      void task.destroy();
    },
  };
}
