/// <reference types="bun-types" />
// Settings › Server through the DOM with happy-dom: the three upgrade cards
// with their env vars and Deploy links on a Sidecar-only install, the
// database copy, the re-pairing with a Cloud URL and a setup code (and the
// confirm-from-another-device path), and the Devices list. The server is a
// scripted Api, the Cloud a scripted fetch, the browser opener a spy.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Capabilities, Device } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { type Api, createApi } from "../../platform/api.ts";
import type { CloudTarget, FetchLike } from "../../platform/cloud.ts";
import { type ShellState, StaticShell } from "../../shell/Shell.tsx";
import { Server, type ServerProps } from "./Server.tsx";

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

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  protocol: 1,
  mode: "sidecar",
  realtime: "websocket",
  holdsConnections: true,
  publicUrl: false,
  localRuntimes: true,
  unlocked: true,
  topology: "sidecar",
  features: {
    realtime: "websocket",
    holdsConnections: true,
    pushWebhooks: false,
    scheduledSendsWhileClosed: false,
    backgroundJobs: true,
    localRuntimes: true,
  },
  servers: [{ id: "sidecar-1", mode: "sidecar", lastSeen: "2026-09-17T09:00:00Z" }],
  ...over,
});

/** A scripted Sidecar: capabilities, the upgrade routes and the devices. */
function fakeApi(over: { capabilities?: Capabilities; devices?: Device[] } = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const base = createApi(() => ({ baseUrl: "http://127.0.0.1:4242", token: "t" }));
  const devices = over.devices ?? [];
  const api: Api = {
    ...base,
    capabilities: async () => over.capabilities ?? caps(),
    upgrade: {
      status: async () => ({
        mode: "sidecar",
        canExport: true,
        lastExport: null,
        attachedHost: null,
        restartRequired: false,
      }),
      export: async () => {
        calls.push({ name: "export", args: [] });
        return { path: "/data/export/monday.dump", bytes: 12, at: "2026-09-17T09:00:00Z" };
      },
      copy: async (databaseUrl, replace) => {
        calls.push({ name: "copy", args: [databaseUrl, replace] });
        return {
          tables: [
            { name: "accounts", rows: 1 },
            { name: "threads", rows: 41 },
          ],
          elapsedMs: 3,
        };
      },
      attach: async (databaseUrl) => {
        calls.push({ name: "attach", args: [databaseUrl] });
        return { restartRequired: true };
      },
      detach: async () => ({ restartRequired: true }),
    },
    devices: {
      list: async () => devices,
      revoke: async (id) => {
        calls.push({ name: "revoke", args: [id] });
        return new Response(null, { status: 204 });
      },
      confirm: async (code) => {
        calls.push({ name: "confirm", args: [code] });
        return { ok: true };
      },
    },
  };
  return { api, calls };
}

interface Mounted {
  opened: string[];
  clouds: Array<CloudTarget | null>;
  calls: { name: string; args: unknown[] }[];
}

async function mount(
  props: Partial<ServerProps> = {},
  shell: Partial<Pick<ShellState, "sidecar" | "cloud" | "server">> = {},
  apiOver: Parameters<typeof fakeApi>[0] = {},
): Promise<Mounted> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  const opened: string[] = [];
  const clouds: Array<CloudTarget | null> = [];
  const { api, calls } = fakeApi(apiOver);
  const sidecar = shell.sidecar ?? { port: 4242, token: "t", running: true };
  const server = shell.server ?? {
    kind: "sidecar" as const,
    target: { baseUrl: "http://127.0.0.1:4242", token: "t" },
  };
  await act(async () =>
    r.render(
      <StaticShell
        shell={{
          api,
          sidecar,
          server,
          cloud: shell.cloud ?? null,
          setCloud: async (t) => {
            clouds.push(t);
          },
        }}
      >
        <Server
          deviceName="Laptop"
          openExternal={async (url) => {
            opened.push(url);
          }}
          {...props}
        />
      </StaticShell>,
    ),
  );
  await settle();
  return { opened, clouds, calls };
}

const q = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const text = () => document.body.textContent ?? "";

async function clickText(label: string) {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
  const el = buttons.find((b) => (b.textContent ?? "").trim() === label);
  if (!el) throw new Error(`no button ${label}`);
  await act(async () => el.click());
}

async function type(selector: string, value: string) {
  const input = q<HTMLInputElement>(selector);
  if (!input) throw new Error(`no input ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const settle = () => act(async () => Bun.sleep(10));

/** A scripted Cloud for the pairing calls. */
function cloudFetch(script: Record<string, Array<{ status: number; body?: unknown }>>) {
  const calls: string[] = [];
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const fetchFn: FetchLike = async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    const queue = queues[path] ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (!next) throw new TypeError("connection refused");
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
  };
  return { fetch: fetchFn, calls };
}

describe("Settings › Server on a Sidecar-only install", () => {
  test("shows the mode, the three cards with their env vars, and opens the Deploy links", async () => {
    const m = await mount();
    expect(text()).toContain("Sidecar only");
    expect(text()).toContain("Sidecar on port 4242");

    const cards = [...document.querySelectorAll(".upgrade-card")];
    expect(cards.map((c) => c.getAttribute("data-platform"))).toEqual([
      "vercel",
      "netlify",
      "container",
    ]);
    const vercel = cards[0];
    const env = [...(vercel?.querySelectorAll(".env-list code") ?? [])].map((c) => c.textContent);
    expect(env).toEqual([
      "DATABASE_URL",
      "DATABASE_URL_UNPOOLED",
      "MONDAY_SETUP_CODE",
      "MONDAY_PUBLIC_URL",
      "MONDAY_ROOT_KEY",
      "MONDAY_MODE",
      "CRON_SECRET",
    ]);
    expect(vercel?.textContent).toContain("scheduled sends while this laptop is closed");
    expect(cards[2]?.textContent).toContain("IMAP accounts without this laptop");

    const deploys = [...document.querySelectorAll<HTMLButtonElement>(".upgrade-card button")];
    await act(async () => deploys[0]?.click());
    await act(async () => deploys[1]?.click());
    await act(async () => deploys[2]?.click());
    expect(m.opened[0]).toStartWith("https://vercel.com/new/clone?");
    expect(m.opened[0]).toContain("repository-url=https%3A%2F%2Fgithub.com%2FdopeCape%2Fmonday");
    expect(m.opened[0]).toContain("root-directory=apps%2Fserver");
    expect(m.opened[0]).toContain("CRON_SECRET");
    expect(m.opened[1]).toStartWith("https://app.netlify.com/start/deploy?");
    expect(m.opened[1]).toContain("base=apps%2Fserver");
    expect(m.opened[2]).toContain("github.com/dopeCape/monday");
  });

  test("copies the database into the Cloud and reports the rows", async () => {
    const m = await mount();
    await type(
      "input[placeholder='postgres://user:password@host/monday']",
      "postgres://u:p@db.neon.tech/monday",
    );
    await clickText("Copy database");
    await settle();
    expect(m.calls).toEqual([{ name: "copy", args: ["postgres://u:p@db.neon.tech/monday", true] }]);
    expect(text()).toContain("Copied 2 tables, 42 rows");
    await clickText("Export a dump instead");
    await settle();
    expect(text()).toContain("Saved /data/export/monday.dump");
  });

  test("connects this device to the Cloud with the setup code and remembers it", async () => {
    const cloud = cloudFetch({
      "/pair/setup": [{ status: 201, body: { deviceId: "d1", token: "tok" } }],
    });
    const m = await mount({ pairFetch: cloud.fetch });
    await type("input[placeholder='https://monday-server.vercel.app']", "monday.example");
    const codeInput = document.querySelectorAll<HTMLInputElement>(".wizard-field input");
    const code = codeInput[2];
    if (!code) throw new Error("no code input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(code, "424242");
      code.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickText("Connect");
    await settle();
    expect(cloud.calls).toEqual(["/pair/setup"]);
    expect(m.clouds).toEqual([{ baseUrl: "https://monday.example", token: "tok", deviceId: "d1" }]);
  });

  test("a Cloud that already has devices shows the code to approve elsewhere, then pairs", async () => {
    const cloud = cloudFetch({
      "/pair/setup": [{ status: 409, body: { error: "setup_already_done" } }],
      "/pair/start": [{ status: 201, body: { code: "654321", secret: "s", expiresAt: "x" } }],
      "/pair/claim": [
        { status: 202, body: { status: "pending" } },
        { status: 200, body: { status: "paired", deviceId: "d2", token: "tok2" } },
      ],
    });
    const m = await mount({ pairFetch: cloud.fetch });
    await type("input[placeholder='https://monday-server.vercel.app']", "https://monday.example");
    const inputs = document.querySelectorAll<HTMLInputElement>(".wizard-field input");
    const code = inputs[2];
    if (!code) throw new Error("no code input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(code, "000000");
      code.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickText("Connect");
    await act(async () => Bun.sleep(2_100));
    await settle();
    expect(cloud.calls.filter((c) => c === "/pair/claim").length).toBeGreaterThanOrEqual(2);
    expect(m.clouds).toEqual([
      { baseUrl: "https://monday.example", token: "tok2", deviceId: "d2" },
    ]);
  }, 10_000);

  test("a wrong setup code and plain http read as typed messages", async () => {
    const cloud = cloudFetch({
      "/pair/setup": [{ status: 403, body: { error: "invalid_setup_code" } }],
    });
    await mount({ pairFetch: cloud.fetch });
    await type("input[placeholder='https://monday-server.vercel.app']", "http://10.0.0.5:8787");
    const inputs = document.querySelectorAll<HTMLInputElement>(".wizard-field input");
    const code = inputs[2];
    if (!code) throw new Error("no code input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(code, "1");
      code.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickText("Connect");
    await settle();
    expect(text()).toContain("That address is plain http");
    await type("input[placeholder='https://monday-server.vercel.app']", "https://monday.example");
    await clickText("Connect");
    await settle();
    expect(text()).toContain("That code is not the one this Cloud printed");
  });
});

describe("Settings › Server once a Cloud is paired", () => {
  const cloud: CloudTarget = { baseUrl: "https://monday.example", token: "tok", deviceId: "d1" };

  test("shows both, the preference, the attach step and the devices; hides the cards", async () => {
    const m = await mount(
      {},
      {
        cloud,
        server: { kind: "cloud", target: cloud },
      },
      {
        capabilities: caps({
          mode: "vercel",
          topology: "both",
          servers: [
            { id: "sidecar-1", mode: "sidecar", lastSeen: "2026-09-17T09:00:00Z" },
            { id: "vercel-1", mode: "vercel", lastSeen: "2026-09-17T09:00:00Z" },
          ],
        }),
        devices: [{ id: "d1", name: "Laptop", lastSeen: "2026-09-17T09:00:00Z" }],
      },
    );
    expect(text()).toContain("Sidecar and Cloud");
    expect(text()).toContain("Cloud at monday.example");
    expect(document.querySelector(".upgrade-cards")).toBeNull();
    expect(text()).toContain("Connected to monday.example");
    expect(text()).toContain("Laptop");

    // The preference is the server.prefer Setting.
    await clickText("Sidecar");
    await settle();

    // Attaching the Sidecar to the Cloud database records it for the next launch.
    // The Move section above has the first database input; the attach step the second.
    const dbInputs = document.querySelectorAll<HTMLInputElement>(
      "input[placeholder='postgres://user:password@host/monday']",
    );
    expect(dbInputs).toHaveLength(2);
    const attachInput = dbInputs[1];
    if (!attachInput) throw new Error("no attach input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(attachInput, "postgres://u:p@db/monday");
      attachInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const attachButtons = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
      (b) => (b.textContent ?? "").trim() === "Share the database with the Sidecar",
    );
    await act(async () => attachButtons[0]?.click());
    await settle();
    expect(m.calls).toContainEqual({ name: "attach", args: ["postgres://u:p@db/monday"] });
    expect(text()).toContain("Restart monday to finish.");

    // Approving a code another device shows.
    await type("input[placeholder='000000']", "123456");
    await clickText("Approve a code");
    await settle();
    expect(m.calls).toContainEqual({ name: "confirm", args: ["123456"] });
    expect(text()).toContain("Approved");

    await clickText("Disconnect");
    await settle();
    expect(m.clouds).toEqual([null]);
  });
});
