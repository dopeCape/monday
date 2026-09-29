/// <reference types="bun-types" />
// Settings › Sync server › Background service through the DOM with happy-dom
// (ADR 0013): running since when, the PID and the memory of the server and
// its Postgres, who runs it, the locked line; Restart restarts at once, Stop
// asks first (mail stops syncing until monday opens again) and only then
// stops; stopped, the card offers Start; with no Sidecar at all (a browser, a
// Cloud-only Device) there is no card. The status is a scripted Api and the
// host's controls a spy.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ServiceStatus } from "@monday/shared";
import { defaultSettings } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { type Api, createApi } from "../../platform/api.ts";
import type { SidecarInfo } from "../../platform/tauri.ts";
import { StaticShell } from "../../shell/Shell.tsx";
import { memoryMb, ServiceCard, type ServiceHost } from "./Service.tsx";

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

const NOW = new Date("2026-09-29T09:41:00");

const status = (over: Partial<ServiceStatus> = {}): ServiceStatus => ({
  pid: 4242,
  port: 51234,
  build: "b1",
  startedAt: new Date("2026-09-29T08:05:00").toISOString(),
  managedBy: "systemd",
  rssBytes: 80 * 1024 * 1024,
  postgresRssBytes: 40 * 1024 * 1024,
  unlocked: true,
  clientPresent: true,
  notified: { mailThrough: null, approvals: [] },
  ...over,
});

const settle = () => act(async () => Bun.sleep(10));
const text = () => document.body.textContent ?? "";

async function clickText(label: string) {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
  const el = buttons.find((b) => (b.textContent ?? "").trim() === label);
  if (!el)
    throw new Error(`no button ${label}; have ${buttons.map((b) => b.textContent).join(", ")}`);
  await act(async () => el.click());
  await settle();
}

async function mount(
  opts: { sidecar?: SidecarInfo | null; status?: ServiceStatus; fail?: string } = {},
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  const calls: string[] = [];
  const base = createApi(() => ({ baseUrl: "http://127.0.0.1:51234", token: "t" }));
  const api: Api = {
    ...base,
    service: {
      status: async () => {
        calls.push("status");
        return opts.status ?? status();
      },
    },
  };
  const serviceHost: ServiceHost = {
    stop: async () => {
      calls.push("stop");
      if (opts.fail) throw new Error(opts.fail);
    },
    restart: async () => {
      calls.push("restart");
      if (opts.fail) throw new Error(opts.fail);
    },
  };
  const sidecar =
    opts.sidecar !== undefined ? opts.sidecar : { port: 51234, token: "t", running: true };
  await act(async () =>
    r.render(
      <StaticShell shell={{ api, sidecar }}>
        <ServiceCard host={serviceHost} now={() => NOW} />
      </StaticShell>,
    ),
  );
  await settle();
  return calls;
}

describe("the Background service card", () => {
  const s = defaultSettings();

  test("running: since when, the PID, the memory of the server and its Postgres, and who runs it", async () => {
    await mount();
    const card = document.querySelector("[data-panel=service]");
    expect(card?.getAttribute("data-running")).toBe("true");
    expect(text()).toContain(s["strings.server.service.title"]);
    expect(text()).toContain("PID 4242");
    expect(text()).toContain("using 120 MB");
    expect(text()).toContain("Running since Today 08:05");
    expect(text()).toContain(s["strings.server.service.managed.systemd"]);
    // The Local runtime's work waits for the app, and the card says so.
    expect(text()).toContain("command-line agent waits until monday is open");
    expect(document.querySelector("[data-service=locked]")).toBeNull();
  });

  test("a locked service says what waits", async () => {
    await mount({ status: status({ unlocked: false, managedBy: "process" }) });
    expect(document.querySelector("[data-service=locked]")?.textContent).toBe(
      s["strings.server.service.locked"],
    );
    expect(text()).toContain(s["strings.server.service.managed.process"]);
  });

  test("Restart restarts at once", async () => {
    const calls = await mount();
    await clickText(s["strings.server.service.restart"]);
    expect(calls).toContain("restart");
  });

  test("Stop asks first, says mail will not sync, and only a yes stops it", async () => {
    const calls = await mount();
    await clickText(s["strings.server.service.stop"]);
    expect(calls).not.toContain("stop");
    expect(document.querySelector("[role=alertdialog]")?.textContent).toContain(
      s["strings.server.service.stop_confirm"],
    );
    expect(s["strings.server.service.stop_confirm"]).toContain("Mail won't sync");
    await clickText(s["strings.settings.cancel"]);
    expect(calls).not.toContain("stop");
    await clickText(s["strings.server.service.stop"]);
    await clickText(s["strings.settings.confirm"]);
    expect(calls).toContain("stop");
  });

  test("a failure is shown on the card", async () => {
    await mount({ fail: "systemctl said no" });
    await clickText(s["strings.server.service.restart"]);
    expect(text()).toContain("The background service did not do that: systemctl said no");
  });

  test("stopped: the stopped line and Start, and no status asked", async () => {
    const calls = await mount({ sidecar: { port: 51234, token: "t", running: false } });
    expect(document.querySelector("[data-panel=service]")?.getAttribute("data-running")).toBe(
      "false",
    );
    expect(text()).toContain(s["strings.server.service.stopped"]);
    expect(calls).not.toContain("status");
    await clickText(s["strings.server.service.start"]);
    expect(calls).toContain("restart");
  });

  test("no Sidecar on this Device: no card", async () => {
    await mount({ sidecar: null });
    expect(document.querySelector("[data-panel=service]")).toBeNull();
  });

  test("memory is the server and its Postgres, whole megabytes", () => {
    expect(memoryMb({ rssBytes: 1.5 * 1024 * 1024, postgresRssBytes: null })).toBe(2);
    expect(memoryMb({ rssBytes: 10 * 1024 * 1024, postgresRssBytes: 5 * 1024 * 1024 })).toBe(15);
  });
});
