/// <reference types="bun-types" />
// The wake transport over the API client (docs/spec/architecture.md,
// "Deployment modes"): it opens what /capabilities offers, steps down from
// WebSocket to SSE to polling after the Setting's number of connections that
// closed without ever opening, resets on an open or on new capabilities, and
// polls at the server.poll_seconds Setting. WebSocket and EventSource are
// scripted globals here; the Api is only asked for the wake URL.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Capabilities } from "@monday/shared";
import type { Api } from "../platform/api.ts";
import { apiTransport, REALTIME_LADDER, type WakeHandlers } from "./transport.ts";

/** A WebSocket or EventSource stand-in the test drives by hand. */
class FakeSocket {
  static opened: FakeSocket[] = [];
  static CLOSED = 2;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  readyState = 0;
  listeners = new Map<string, (e: { data: string }) => void>();
  constructor(public url: string) {
    FakeSocket.opened.push(this);
  }
  addEventListener(name: string, listener: (e: { data: string }) => void) {
    this.listeners.set(name, listener);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
  }
  /** The server accepted the connection. */
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  /** The connection dropped (a proxy refused it, the Server went away). */
  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
    this.onerror?.();
  }
}

const globals = globalThis as { WebSocket?: unknown; EventSource?: unknown };
let savedWs: unknown;
let savedEs: unknown;
beforeEach(() => {
  savedWs = globals.WebSocket;
  savedEs = globals.EventSource;
  globals.WebSocket = FakeSocket;
  globals.EventSource = FakeSocket;
  FakeSocket.opened = [];
});
afterEach(() => {
  globals.WebSocket = savedWs;
  globals.EventSource = savedEs;
});

const api = {
  wakeUrl: (path: string, workspaceId: string) => `http://s${path}?workspace=${workspaceId}`,
} as unknown as Api;

function caps(realtime: Capabilities["realtime"]): Capabilities {
  return { realtime } as Capabilities;
}

function handlers() {
  const events: string[] = [];
  const h: WakeHandlers = {
    onOpen: () => events.push("open"),
    onWake: (seq) => events.push(`wake:${seq}`),
    onClose: () => events.push("close"),
  };
  return { h, events };
}

describe("apiTransport", () => {
  test("opens what the Server offers and reports open, wake and close", () => {
    const t = apiTransport(api, {
      capabilities: () => caps("websocket"),
      pollSeconds: () => 30,
      fallbackAfter: () => 3,
    });
    const { h, events } = handlers();
    const c = t.connect("ws-1", h);
    const socket = FakeSocket.opened[0];
    expect(socket?.url).toBe("ws://s/changes/ws?workspace=ws-1");
    socket?.open();
    socket?.onmessage?.({ data: JSON.stringify({ seq: 7 }) });
    socket?.onmessage?.({ data: "not json" });
    expect(events).toEqual(["open", "wake:7"]);
    c.close();
    // A close the Store asked for is not reported back as a drop.
    socket?.onclose?.();
    expect(events).toEqual(["open", "wake:7"]);
  });

  test("steps down a rung after the Setting's number of connections that never opened", () => {
    const log: string[] = [];
    const t = apiTransport(api, {
      capabilities: () => caps("websocket"),
      pollSeconds: () => 30,
      fallbackAfter: () => 2,
      log: (m) => log.push(m),
    });
    const { h, events } = handlers();
    t.connect("ws-1", h);
    FakeSocket.opened[0]?.drop();
    t.connect("ws-1", h);
    FakeSocket.opened[1]?.drop();
    expect(log).toEqual(["wake: websocket never opened; falling back to sse"]);
    // The third connection is SSE, at the sse path.
    t.connect("ws-1", h);
    expect(FakeSocket.opened[2]?.url).toBe("http://s/changes/sse?workspace=ws-1");
    // SSE that opens resets the count; a wake arrives through its event listener.
    FakeSocket.opened[2]?.open();
    FakeSocket.opened[2]?.listeners.get("wake")?.({ data: JSON.stringify({ seq: 9 }) });
    expect(events.slice(-2)).toEqual(["open", "wake:9"]);
    // Two SSE drops without opening step down to polling, which opens on its own.
    t.connect("ws-1", h);
    FakeSocket.opened[3]?.drop();
    t.connect("ws-1", h);
    FakeSocket.opened[4]?.drop();
    expect(log.at(-1)).toBe("wake: sse never opened; falling back to polling");
    expect(REALTIME_LADDER).toEqual(["websocket", "sse", "polling"]);
    const before = FakeSocket.opened.length;
    const polling = t.connect("ws-1", h);
    expect(FakeSocket.opened.length).toBe(before);
    polling.close();
  });

  test("new capabilities put the transport back on the rung the Server offers", () => {
    let offered: Capabilities["realtime"] = "websocket";
    const t = apiTransport(api, {
      capabilities: () => caps(offered),
      pollSeconds: () => 30,
      fallbackAfter: () => 1,
    });
    const { h } = handlers();
    t.connect("ws-1", h);
    FakeSocket.opened[0]?.drop();
    t.connect("ws-1", h);
    expect(FakeSocket.opened[1]?.url).toContain("/changes/sse");
    offered = "sse";
    t.connect("ws-1", h);
    expect(FakeSocket.opened[2]?.url).toContain("/changes/sse");
    offered = "websocket";
    t.connect("ws-1", h);
    expect(FakeSocket.opened[3]?.url).toContain("/changes/ws");
  });

  test("polling wakes at the Setting's interval and stops on close", async () => {
    const t = apiTransport(api, {
      capabilities: () => caps("polling"),
      pollSeconds: () => 0.01,
      fallbackAfter: () => 3,
    });
    const { h, events } = handlers();
    const c = t.connect("ws-1", h);
    await Bun.sleep(35);
    c.close();
    const wakes = events.filter((e) => e === "wake:-1").length;
    expect(events[0]).toBe("open");
    expect(wakes).toBeGreaterThanOrEqual(2);
    await Bun.sleep(25);
    expect(events.filter((e) => e === "wake:-1").length).toBe(wakes);
  });

  test("without a wake URL (no Server) the connection closes at once", async () => {
    const none = { wakeUrl: () => null } as unknown as Api;
    const t = apiTransport(none, {
      capabilities: () => caps("websocket"),
      pollSeconds: () => 30,
      fallbackAfter: () => 3,
    });
    const { h, events } = handlers();
    t.connect("ws-1", h);
    await Bun.sleep(1);
    expect(events).toEqual(["close"]);
  });
});
