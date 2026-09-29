/// <reference types="bun-types" />
// Connect a tool through the DOM (docs/spec/settings.md "MCP servers"): the
// search goes to the Server as you type and comes back as cards; Enter on the
// focused card connects it; a server that signs in with OAuth opens the
// browser with Cancel while it is open; a local package asks only its
// declared inputs, the secret one masked; the tools come back with every one
// on and the choice is saved; the connected list shows the status, the
// tools and Remove. The Server is a fake fetch behind the real Api client.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  defaultSettings,
  type McpCatalogEntry,
  type McpServerView,
  type McpToolView,
  type Settings,
} from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createApi } from "../../platform/api.ts";
import { ConnectTool, connectBodyFor, McpServerList } from "./ConnectTool.tsx";

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

const settle = () => act(async () => Bun.sleep(20));
const q = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const qa = <T extends Element = HTMLElement>(selector: string) => [
  ...document.querySelectorAll<T>(selector),
];

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => (el as HTMLElement).click());
  await settle();
}
async function clickText(label: string, within: ParentNode = document) {
  const el = [...within.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    (b.textContent ?? "").trim().endsWith(label),
  );
  if (!el) throw new Error(`no button ${label}`);
  await click(el);
}
async function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error("no input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
async function key(target: Element | null, k: string) {
  if (!target) throw new Error("no target");
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await settle();
}

const LINEAR: McpCatalogEntry = {
  id: "app.linear/linear",
  name: "linear",
  title: "Linear",
  publisher: "linear.app",
  description: "Issues and projects.",
  version: "1.0.0",
  websiteUrl: null,
  iconUrl: null,
  remote: {
    url: "https://mcp.linear.test/mcp",
    transport: "streamable-http",
    headers: {},
    inputs: [],
  },
  local: null,
};
const WEATHER: McpCatalogEntry = {
  id: "io.github.someone/weather",
  name: "weather",
  title: "weather",
  publisher: "someone",
  description: "Forecasts.",
  version: "0.3.1",
  websiteUrl: null,
  iconUrl: null,
  remote: null,
  local: {
    registryType: "npm",
    identifier: "@someone/weather-mcp",
    version: "0.3.1",
    command: "npx",
    args: ["-y", "@someone/weather-mcp@0.3.1", "{region}"],
    env: { WEATHER_KEY: "{WEATHER_KEY}", UNITS: "{UNITS}", DEBUG: "{DEBUG}" },
    inputs: [
      {
        kind: "variable",
        name: "region",
        description: "",
        required: true,
        secret: false,
        default: null,
        choices: [],
      },
      {
        kind: "env",
        name: "WEATHER_KEY",
        description: "API key",
        required: true,
        secret: true,
        default: null,
        choices: [],
      },
      {
        kind: "env",
        name: "UNITS",
        description: "",
        required: false,
        secret: false,
        default: "metric",
        choices: ["metric", "imperial"],
      },
      {
        kind: "env",
        name: "DEBUG",
        description: "",
        required: false,
        secret: false,
        default: null,
        choices: [],
      },
    ],
  },
};
const TOOLS: McpToolView[] = [
  { name: "list_issues", description: "Lists issues", enabled: true },
  { name: "create_issue", description: "Creates an issue", enabled: true },
];

function view(name: string, over: Partial<McpServerView> = {}): McpServerView {
  return {
    name,
    title: name,
    registry: null,
    kind: "remote",
    target: "https://x.test/mcp",
    auth: "none",
    secrets: [],
    tools: [],
    status: "connected",
    message: null,
    ...over,
  };
}

/** The Server's MCP routes, scripted; every request is recorded. */
function fakeServer(options: { signIn?: "done" | "pending"; next?: "sign_in" | "ready" } = {}) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  let polls = 0;
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, path: u.pathname + u.search, body });
    if (u.pathname === "/mcp-servers/catalog") {
      const q = (u.searchParams.get("q") ?? "").toLowerCase();
      return Response.json({
        enabled: true,
        entries: [LINEAR, WEATHER].filter((e) => e.id.includes(q)),
      });
    }
    if (u.pathname === "/mcp-servers" && method === "POST") {
      const next = body.url ? (options.next ?? "sign_in") : "ready";
      return Response.json({
        server: view(body.name, {
          title: body.title ?? body.name,
          auth: next === "sign_in" ? "oauth" : "inputs",
          status: next === "sign_in" ? "needs_sign_in" : "connected",
        }),
        next,
        tools: next === "ready" ? TOOLS : [],
      });
    }
    if (u.pathname === "/mcp-servers" && method === "GET") {
      return Response.json({
        servers: [
          view("linear", { title: "Linear", auth: "oauth", status: "needs_sign_in" }),
          view("notes", { kind: "local", target: "notes-mcp", tools: ["list_issues"] }),
        ],
      });
    }
    if (u.pathname.endsWith("/sign-in") && method === "POST") {
      return Response.json({ state: "st-1", url: "https://auth.test/authorize?state=st-1" });
    }
    if (u.pathname === "/mcp-servers/sign-in/status") {
      polls += 1;
      if ((options.signIn ?? "done") === "done" && polls > 1) {
        return Response.json({ status: "done", server: view("linear") });
      }
      return Response.json({ status: "pending" });
    }
    if (u.pathname === "/mcp-servers/sign-in/cancel") return Response.json({ status: "cancelled" });
    if (u.pathname.endsWith("/tools")) {
      const name = decodeURIComponent(u.pathname.split("/")[2] ?? "");
      // "notes" allows only list_issues; the Server marks the rest off.
      const allowed = name === "notes" ? ["list_issues"] : [];
      return Response.json({
        server: view(name, { tools: allowed }),
        tools: TOOLS.map((t) => ({
          ...t,
          enabled: allowed.length === 0 || allowed.includes(t.name),
        })),
      });
    }
    if (method === "PATCH") {
      const name = decodeURIComponent(u.pathname.split("/")[2] ?? "");
      return Response.json({ server: view(name, { tools: body.tools }) });
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    return new Response("not found", { status: 404 });
  };
  const api = createApi(() => ({ baseUrl: "http://server.test", token: "t" }), { fetch });
  return { api, requests };
}

const S: Settings = { ...defaultSettings(), "workflows.mcp_connect.debounce_ms": 0 };

async function mountDialog(
  server: ReturnType<typeof fakeServer>,
  extra: { onClose?: () => void; opened?: string[]; canRunLocal?: boolean } = {},
) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const opened = extra.opened ?? [];
  await act(async () =>
    root?.render(
      <ConnectTool
        api={server.api}
        workspaceId="ws-1"
        s={S}
        openExternal={async (url) => {
          opened.push(url);
        }}
        onClose={extra.onClose ?? (() => {})}
        canRunLocal={extra.canRunLocal}
        pollMs={5}
      />,
    ),
  );
  await settle();
}

describe("Connect a tool", () => {
  test("search as you type, Enter connects the focused card, OAuth in the browser, then choose tools", async () => {
    const server = fakeServer();
    const opened: string[] = [];
    let closed = false;
    await mountDialog(server, { opened, onClose: () => (closed = true) });
    const search = q<HTMLInputElement>(".mcp-search input");
    expect(document.activeElement).toBe(search);
    await type(search, "linear");
    expect(server.requests.at(-1)?.path).toBe("/mcp-servers/catalog?q=linear");
    const cards = qa(".mcp-card");
    expect(cards.map((c) => c.getAttribute("data-entry"))).toEqual(["app.linear/linear"]);
    expect(cards[0]?.textContent).toContain("by linear.app");
    expect(cards[0]?.textContent).toContain("Hosted");
    expect(cards[0]?.getAttribute("aria-selected")).toBe("true");

    await key(search, "Enter");
    await settle();
    await settle();
    const post = server.requests.find((r) => r.method === "POST" && r.path === "/mcp-servers");
    expect(post?.body).toMatchObject({
      workspace: "ws-1",
      name: "linear",
      registry: "app.linear/linear",
      url: "https://mcp.linear.test/mcp",
      replace: true,
    });
    expect(opened).toEqual(["https://auth.test/authorize?state=st-1"]);
    await settle();
    await settle();
    // Signed in: the tools, all on.
    const boxes = qa<HTMLInputElement>(".mcp-tool input");
    expect(boxes.map((b) => b.checked)).toEqual([true, true]);
    await click(q('[data-tool="create_issue"] input'));
    await clickText("Done");
    const patch = server.requests.find((r) => r.method === "PATCH");
    expect(patch?.path).toBe("/mcp-servers/linear");
    expect(patch?.body).toEqual({ tools: ["list_issues"] });
    expect(closed).toBe(true);
  });

  test("Cancel while the browser is open tells the Server and says so", async () => {
    const server = fakeServer({ signIn: "pending" });
    await mountDialog(server);
    await type(q<HTMLInputElement>(".mcp-search input"), "linear");
    await click(q('[data-entry="app.linear/linear"]'));
    await settle();
    expect(q(".mcp-waiting")?.textContent).toContain(
      "Finish signing in to Linear in your browser.",
    );
    await clickText("Cancel", q(".mcp-waiting") ?? document);
    expect(server.requests.some((r) => r.path === "/mcp-servers/sign-in/cancel")).toBe(true);
    expect(q(".mcp-stage")?.textContent).toContain("Sign-in cancelled.");
  });

  test("a local package asks only its declared inputs, masks the secret, and sends it to be sealed", async () => {
    const server = fakeServer();
    await mountDialog(server);
    await type(q<HTMLInputElement>(".mcp-search input"), "weather");
    await key(q(".mcp-search input"), "Enter");
    expect(qa(".mcp-field").map((f) => f.getAttribute("data-input"))).toEqual([
      "region",
      "WEATHER_KEY",
      "UNITS",
      "DEBUG",
    ]);
    expect(q<HTMLInputElement>('[data-input="WEATHER_KEY"] input')?.type).toBe("password");
    expect(q(".mcp-runs")?.textContent).toContain("npx -y @someone/weather-mcp@0.3.1 {region}");
    const connectBtn = [...qa<HTMLButtonElement>(".mcp-form button")].find(
      (b) => b.textContent === "Connect",
    );
    expect(connectBtn?.disabled).toBe(true);
    await type(q<HTMLInputElement>('[data-input="region"] input'), "eu");
    await type(q<HTMLInputElement>('[data-input="WEATHER_KEY"] input'), "wk-otter");
    await click(connectBtn);
    await settle();
    const post = server.requests.find((r) => r.method === "POST" && r.path === "/mcp-servers");
    expect(post?.body).toMatchObject({
      command: "npx",
      args: ["-y", "@someone/weather-mcp@0.3.1", "{region}"],
      // The blank optional DEBUG is left out rather than sent as a hole.
      env: { WEATHER_KEY: "{WEATHER_KEY}", UNITS: "{UNITS}" },
      values: { region: "eu", WEATHER_KEY: "wk-otter", UNITS: "metric" },
      secret: ["WEATHER_KEY"],
    });
    expect(qa(".mcp-tool").length).toBe(2);
  });

  test("an input with choices is monday's Select, named by its label; Escape in it leaves the dialog open", async () => {
    const server = fakeServer();
    let closed = false;
    await mountDialog(server, { onClose: () => (closed = true) });
    await type(q<HTMLInputElement>(".mcp-search input"), "weather");
    await key(q(".mcp-search input"), "Enter");
    const units = q<HTMLButtonElement>('[data-input="UNITS"] button.dd');
    expect(units?.id).toBe("mcp-in-UNITS");
    expect(q('label[for="mcp-in-UNITS"]')).not.toBeNull();
    expect(units?.textContent).toBe("metric");
    await click(units);
    expect(qa("[role='option']").map((o) => o.textContent)).toEqual(["metric", "imperial"]);
    await key(document.activeElement, "Escape");
    expect(closed).toBe(false);
    expect(qa("[role='option']")).toHaveLength(0);
    await click(units);
    await click(qa("[role='option']")[1]);
    expect(units?.textContent).toBe("imperial");
    await type(q<HTMLInputElement>('[data-input="region"] input'), "eu");
    await type(q<HTMLInputElement>('[data-input="WEATHER_KEY"] input'), "wk-otter");
    await clickText("Connect", q(".mcp-form") ?? document);
    const post = server.requests.find((r) => r.method === "POST" && r.path === "/mcp-servers");
    expect(post?.body).toMatchObject({ values: { UNITS: "imperial" } });
  });

  test("keyboard: typing or / focuses the search, arrows move, Escape closes", async () => {
    const server = fakeServer();
    let closed = false;
    await mountDialog(server, { onClose: () => (closed = true) });
    await type(q<HTMLInputElement>(".mcp-search input"), "");
    const search = q<HTMLInputElement>(".mcp-search input");
    expect(qa(".mcp-card")).toHaveLength(2);
    await key(search, "ArrowDown");
    expect(q(".mcp-card.on")?.getAttribute("data-entry")).toBe("io.github.someone/weather");
    const add = [...qa<HTMLButtonElement>(".mcp-foot button")][0] ?? null;
    add?.focus();
    await key(add, "/");
    expect(document.activeElement).toBe(search);
    await key(document.body, "Escape");
    expect(closed).toBe(true);
  });

  test("Add by URL connects any server by its address, with an optional key", async () => {
    const server = fakeServer({ next: "ready" });
    await mountDialog(server);
    await clickText("Add by URL");
    await type(q<HTMLInputElement>("#mcp-url"), "https://mcp.acme.test/mcp");
    expect(q<HTMLInputElement>("#mcp-name")?.value).toBe("acme");
    await type(q<HTMLInputElement>("#mcp-token"), "sk-1");
    await clickText("Connect");
    const post = server.requests.find((r) => r.method === "POST" && r.path === "/mcp-servers");
    expect(post?.body).toMatchObject({
      name: "acme",
      url: "https://mcp.acme.test/mcp",
      token: "sk-1",
    });
  });

  test("the body for a remote card drops a header whose optional input is blank", () => {
    const entry: McpCatalogEntry = {
      ...LINEAR,
      remote: {
        url: "https://x.test/{tenant}/mcp",
        transport: "sse",
        headers: { Authorization: "Bearer {api_key}", "X-Org": "{org}" },
        inputs: [],
      },
    };
    expect(connectBodyFor(entry, "remote", { tenant: "t1", api_key: "k", org: "" })).toMatchObject({
      url: "https://x.test/{tenant}/mcp",
      transport: "sse",
      headers: { Authorization: "Bearer {api_key}" },
      values: { tenant: "t1", api_key: "k" },
    });
  });
});

describe("the connected list", () => {
  test("status per server, Sign in for one that needs it, the tools, and Remove", async () => {
    const server = fakeServer();
    let changed = 0;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root?.render(
        <McpServerList
          api={server.api}
          workspaceId="ws-1"
          s={S}
          servers={[
            { name: "linear", tools: [] },
            { name: "notes", command: "notes-mcp", tools: ["list_issues"] },
          ]}
          openExternal={async () => {}}
          onChanged={() => (changed += 1)}
          pollMs={5}
          removeAction={(_server, remove) => (
            <button type="button" onClick={() => void remove()}>
              Remove
            </button>
          )}
        />,
      ),
    );
    await settle();
    const linear = q('[data-mcp="linear"]');
    expect(linear?.textContent).toContain("Needs sign-in");
    expect(linear?.textContent).toContain("Sign in");
    const notes = q('[data-mcp="notes"]');
    expect(notes?.textContent).toContain("Connected");
    expect(notes?.textContent).toContain("1 tools");

    await clickText("Tools", notes ?? document);
    expect(
      qa('[data-mcp="notes"] .mcp-tool input').map((b) => (b as HTMLInputElement).checked),
    ).toEqual([true, false]);

    await clickText("Remove", notes ?? document);
    expect(
      server.requests.some((r) => r.method === "DELETE" && r.path === "/mcp-servers/notes"),
    ).toBe(true);
    expect(q('[data-mcp="notes"]')).toBeNull();
    expect(changed).toBe(1);
  });
});
