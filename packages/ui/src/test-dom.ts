// The DOM for render tests: registers happy-dom, then loads react-dom/client.
// react-dom is CommonJS, and Bun evaluates CommonJS dependencies while linking
// a test file, before the file's own body runs. A static import would see no
// window and switch React's onChange plugin to a polyfill that never fires
// for typed input, so every render test loads react-dom through here, after
// the DOM exists. The global registration stays for the rest of the run,
// which is why the tests that need a real TransformStream (the server's SSE)
// run before any of these in bun's file order.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

export async function dom(): Promise<typeof import("react-dom/client")> {
  if (typeof document === "undefined") GlobalRegistrator.register();
  if (!("oninput" in document)) {
    // React checks this property to decide whether `input` events exist.
    Object.defineProperty(document, "oninput", { value: null, writable: true, configurable: true });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return import("react-dom/client");
}
