import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // The browser dev server runs the Store over SQLite in WebAssembly; the
  // package must not be pre-bundled or its wasm cannot be located.
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    ...(host ? { hmr: { protocol: "ws", host, port: 1421 } } : {}),
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
