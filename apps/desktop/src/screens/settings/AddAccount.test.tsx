/// <reference types="bun-types" />
// The add-account paths through the DOM with happy-dom: the picker, every
// step of both wizards, the live validation states, the IMAP escape hatch and
// the redirect from IMAP to a wizard, the JMAP token paste. The server is a
// scripted Api; the browser opener is a spy.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import {
  type AccountView,
  type Api,
  createApi,
  type Discovery,
  type OAuthStatus,
  type ValidationResult,
} from "../../platform/api.ts";
import { StaticShell } from "../../shell/Shell.tsx";
import { AddAccount, type AddAccountProps } from "./AddAccount.tsx";

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

const account = (overrides: Partial<AccountView> = {}): AccountView => ({
  id: "acct-1",
  workspaceId: "ws-1",
  provider: "gmail",
  address: "me@gmail.com",
  displayName: "",
  capabilities: {
    push: true,
    labels: true,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
  },
  connected: true,
  lastSync: null,
  lastError: null,
  ...overrides,
});

interface Script {
  validate?: (provider: string, params: Record<string, string>) => ValidationResult;
  status?: OAuthStatus[];
  discover?: (address: string) => Discovery;
}

/** A scripted server: records every call, answers from the script. */
function fakeApi(script: Script = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const statuses = [...(script.status ?? [])];
  const base = createApi(() => null);
  const api: Api = {
    ...base,
    accounts: {
      ...base.accounts,
      list: async () => ({ accounts: [] }),
      discover: async (address) => {
        calls.push({ name: "discover", args: [address] });
        return script.discover?.(address) ?? { kind: "manual", tried: [] };
      },
      add: async (body) => {
        calls.push({ name: "add", args: [body] });
        return { account: account({ provider: body.provider, address: body.address }) };
      },
      remove: async (id) => {
        calls.push({ name: "remove", args: [id] });
        return {};
      },
    },
    oauth: {
      validate: async (provider, params) => {
        calls.push({ name: "validate", args: [provider, params] });
        return script.validate?.(provider, params) ?? { ok: true, detail: "recognized" };
      },
      start: async (provider, body) => {
        calls.push({ name: "start", args: [provider, body] });
        return {
          state: "st-1",
          url: `https://auth.example/${provider}?state=st-1`,
          redirectUri: "http://127.0.0.1:1/callback",
        };
      },
      status: async (provider, state) => {
        calls.push({ name: "status", args: [provider, state] });
        return statuses.shift() ?? { status: "pending" };
      },
      finish: async () => ({ account: account() }),
    },
  };
  return { api, calls };
}

async function mount(props: Partial<AddAccountProps> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  const opened: string[] = [];
  const logs: string[] = [];
  const added: AccountView[] = [];
  let t = 1_000_000;
  await act(async () =>
    r.render(
      <StaticShell>
        <AddAccount
          openExternal={async (url) => {
            opened.push(url);
          }}
          now={() => t}
          validateDebounceMs={0}
          pollMs={1}
          log={(line) => logs.push(line)}
          onAdded={(a) => added.push(a)}
          {...props}
        />
      </StaticShell>,
    ),
  );
  return { opened, logs, added, advance: (ms: number) => (t += ms) };
}

const q = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const text = () => document.body.textContent ?? "";
const step = () => q(".wizard")?.getAttribute("data-step") ?? null;
const sentence = () => q(".wizard-sentence")?.textContent ?? "";

async function click(selector: string) {
  const el = q<HTMLButtonElement>(selector);
  if (!el) throw new Error(`no element ${selector}`);
  await act(async () => el.click());
}

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

describe("Add account: the picker", () => {
  test("shows the four paths and opens each", async () => {
    await mount();
    expect(text()).toContain("Add an account");
    const cards = [...document.querySelectorAll(".prov")].map(
      (c) => c.querySelector("b")?.textContent,
    );
    expect(cards).toEqual(["Fastmail or JMAP", "IMAP", "Google", "Microsoft"]);
    await click(".prov:nth-child(3)");
    expect(text()).toContain("Connect Google");
    expect(step()).toBe("project");
    await clickText("Back");
    expect(text()).toContain("Add an account");
    await click(".prov:nth-child(4)");
    expect(text()).toContain("Connect Microsoft");
  });
});

describe("Add account: the Google wizard", () => {
  test("every step renders one sentence and one action, with deep links into the console", async () => {
    const { api } = fakeApi();
    const { opened } = await mount({ initial: "google", api });
    expect(step()).toBe("project");
    expect(sentence()).toBe("Create a Google Cloud project for monday.");
    expect(text()).toContain("Step 1 of 7");
    expect(text()).toContain("Use IMAP with an app password instead");
    await clickText("Create project");
    expect(opened).toEqual(["https://console.cloud.google.com/projectcreate"]);
    await type(".wizard-field input", "monday-1");

    await clickText("Next");
    expect(step()).toBe("api");
    expect(sentence()).toBe("Enable the Gmail API in that project.");
    await clickText("Enable Gmail API");
    expect(opened.at(-1)).toBe(
      "https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=monday-1",
    );

    await clickText("Next");
    expect(step()).toBe("consent");
    expect(sentence()).toContain("External");
    expect(sentence()).toContain("In production");
    expect(q(".wizard-figure")).not.toBeNull();
    expect(text()).toContain("Testing makes Google forget the sign-in every seven days");

    await clickText("Next");
    expect(step()).toBe("client");
    expect(sentence()).toBe("Create an OAuth client of type Desktop app.");
    await clickText("Create client");
    expect(opened.at(-1)).toBe(
      "https://console.cloud.google.com/auth/clients/create?project=monday-1",
    );

    await clickText("Next");
    expect(step()).toBe("paste");
    expect(text()).toContain("Step 5 of 7");
    expect(q<HTMLButtonElement>(".wizard-foot .btn.primary")?.disabled).toBe(true);
  });

  test("the paste box validates live: red with the exact reason, then green, then Next", async () => {
    const { api, calls } = fakeApi({
      validate: (_provider, params) =>
        params.clientSecret === "GOCSPX-right"
          ? { ok: true, detail: "Google recognizes this client id and secret." }
          : { ok: false, field: "clientSecret", reason: "Google rejected the client secret." },
    });
    await mount({ initial: "google", api });
    for (let i = 0; i < 4; i++) await clickText("Next");
    expect(step()).toBe("paste");
    const inputs = () => [...document.querySelectorAll<HTMLInputElement>(".wizard-field input")];
    await type(".wizard-field:nth-child(1) input", "1234-abc.apps.googleusercontent.com");
    // Nothing runs until both boxes have something.
    await settle();
    expect(calls.filter((c) => c.name === "validate")).toHaveLength(0);
    await type(".wizard-field:nth-child(2) input", "GOCSPX-wrong");
    await settle();
    expect(calls.filter((c) => c.name === "validate")).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "google",
      { clientId: "1234-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-wrong" },
    ]);
    expect(q('[role="alert"]')?.textContent).toContain("Google rejected the client secret.");
    expect(inputs()[1]?.className).toContain("bad");
    expect(q<HTMLButtonElement>(".wizard-foot .btn.primary")?.disabled).toBe(true);

    await type(".wizard-field:nth-child(2) input", "GOCSPX-right");
    await settle();
    expect(q('[role="status"]')?.textContent).toContain("Looks right");
    expect(inputs()[0]?.className).toContain("ok");
    expect(q<HTMLButtonElement>(".wizard-foot .btn.primary")?.disabled).toBe(false);
    await clickText("Next");
    expect(step()).toBe("pubsub");
  });

  test("the Pub/Sub step shows the publisher to copy and can be skipped; sign-in opens the browser and waits", async () => {
    const { api, calls } = fakeApi({
      status: [
        { status: "pending" },
        { status: "done", account: account({ address: "me@gmail.com" }) },
      ],
    });
    const { opened, logs, added, advance } = await mount({ initial: "google", api });
    for (let i = 0; i < 4; i++) await clickText("Next");
    await type(".wizard-field:nth-child(1) input", "1234-abc.apps.googleusercontent.com");
    await type(".wizard-field:nth-child(2) input", "GOCSPX-secret");
    await settle();
    await clickText("Next");
    expect(step()).toBe("pubsub");
    expect(sentence()).toContain("Pub/Sub topic");
    expect(q(".wizard-copy code")?.textContent).toBe("gmail-api-push@system.gserviceaccount.com");
    expect(text()).toContain("Copy");
    await type(".wizard-field:nth-child(2) input", "projects/monday-1/topics/monday-gmail");
    await clickText("Next");
    expect(step()).toBe("signin");
    expect(sentence()).toBe("Sign in with Google and allow monday to read and send your mail.");
    // No Next here: the sign-in itself advances.
    expect(
      [...document.querySelectorAll(".wizard-foot button")].map((b) => b.textContent?.trim()),
    ).toEqual(["Back"]);

    advance(12 * 60_000 + 3_000);
    await clickText("Sign in");
    await act(async () => Bun.sleep(30));
    const start = calls.find((c) => c.name === "start");
    expect(start?.args).toEqual([
      "google",
      {
        clientId: "1234-abc.apps.googleusercontent.com",
        clientSecret: "GOCSPX-secret",
        pubsubTopic: "projects/monday-1/topics/monday-gmail",
      },
    ]);
    expect(opened.at(-1)).toBe("https://auth.example/google?state=st-1");
    expect(calls.filter((c) => c.name === "status").length).toBeGreaterThanOrEqual(2);
    expect(step()).toBe("done");
    expect(text()).toContain("me@gmail.com is connected and syncing.");
    expect(text()).toContain("Set up in 12m 03s");
    expect(logs).toEqual(["[wizard] google completed in 12m 03s (target 15m)"]);
    expect(added.map((a) => a.address)).toEqual(["me@gmail.com"]);
    await clickText("Done");
    expect(text()).toContain("Add an account");
  });

  test("a failed sign-in shows the reason and offers a retry", async () => {
    const { api } = fakeApi({ status: [{ status: "error", message: "access_denied" }] });
    await mount({ initial: "google", api });
    for (let i = 0; i < 4; i++) await clickText("Next");
    await type(".wizard-field:nth-child(1) input", "1234-abc.apps.googleusercontent.com");
    await type(".wizard-field:nth-child(2) input", "GOCSPX-secret");
    await settle();
    await clickText("Next");
    await clickText("Skip");
    expect(step()).toBe("signin");
    await clickText("Sign in");
    await act(async () => Bun.sleep(20));
    expect(text()).toContain("Sign-in failed: access_denied");
    await clickText("Try again");
    expect(text()).not.toContain("Sign-in failed");
    expect(step()).toBe("signin");
  });

  test("the escape hatch leaves the wizard for the IMAP form", async () => {
    const { api } = fakeApi();
    await mount({ initial: "google", api });
    await clickText("Next");
    await click(".wizard-escape");
    expect(text()).toContain("Find settings");
    expect(q(".wizard-escape")).toBeNull();
  });
});

describe("Add account: the Microsoft wizard", () => {
  test("register, account type, platform, paste with the tenant, sign in", async () => {
    const { api, calls } = fakeApi({
      validate: (_provider, params) =>
        params.tenant === "consumers"
          ? { ok: true, detail: "Microsoft recognizes this app in consumers." }
          : { ok: false, field: "tenant", reason: `Microsoft has no tenant "${params.tenant}".` },
      status: [
        { status: "done", account: account({ provider: "graph", address: "me@outlook.com" }) },
      ],
    });
    const { opened, logs } = await mount({ initial: "microsoft", api });
    expect(step()).toBe("register");
    expect(text()).toContain("Step 1 of 5");
    expect(sentence()).toBe("Register an application in Microsoft Entra.");
    await clickText("Register app");
    expect(opened.at(-1)).toContain("entra.microsoft.com");

    await clickText("Next");
    expect(step()).toBe("accountType");
    expect(sentence()).toBe("Choose who can sign in.");
    const work = [...document.querySelectorAll<HTMLButtonElement>(".mode button")][1];
    await act(async () => work?.click());
    expect(work?.getAttribute("aria-pressed")).toBe("true");

    await clickText("Next");
    expect(step()).toBe("platform");
    expect(sentence()).toContain("http://localhost");

    await clickText("Next");
    expect(step()).toBe("paste");
    // A work account shows the tenant box; a wrong tenant is red on the tenant.
    expect(document.querySelectorAll(".wizard-field input")).toHaveLength(2);
    await type(".wizard-field:nth-child(1) input", "12345678-1234-1234-1234-123456789abc");
    await type(".wizard-field:nth-child(2) input", "nowhere");
    await settle();
    expect(q('[role="alert"]')?.textContent).toContain('Microsoft has no tenant "nowhere".');
    expect(calls.find((c) => c.name === "validate")?.args).toEqual([
      "microsoft",
      { clientId: "12345678-1234-1234-1234-123456789abc", tenant: "nowhere" },
    ]);
    // Back to personal: the tenant box goes away and consumers is used.
    await clickText("Back");
    await clickText("Back");
    const personal = [...document.querySelectorAll<HTMLButtonElement>(".mode button")][0];
    await act(async () => personal?.click());
    await clickText("Next");
    await clickText("Next");
    expect(document.querySelectorAll(".wizard-field input")).toHaveLength(1);
    await settle();
    expect(q('[role="status"]')?.textContent).toContain("Looks right");
    await clickText("Next");
    expect(step()).toBe("signin");
    await clickText("Sign in");
    await act(async () => Bun.sleep(20));
    expect(calls.find((c) => c.name === "start")?.args).toEqual([
      "microsoft",
      {
        clientId: "12345678-1234-1234-1234-123456789abc",
        tenant: "consumers",
        pubsubTopic: null,
      },
    ]);
    expect(step()).toBe("done");
    expect(text()).toContain("me@outlook.com is connected and syncing.");
    expect(logs[0]).toContain("[wizard] microsoft completed in");
    expect(logs[0]).toContain("(target 10m)");
  });
});

describe("Add account: IMAP and JMAP", () => {
  test("IMAP finds settings by autoconfig and connects with an app password", async () => {
    const { api, calls } = fakeApi({
      discover: () => ({
        kind: "found",
        source: "ispdb",
        imap: { host: "imap.fastmail.com", port: 993, tls: "tls" },
        smtp: { host: "smtp.fastmail.com", port: 465, tls: "tls" },
        username: "pat@fastmail.com",
        needsOAuth: null,
      }),
    });
    const { added } = await mount({ initial: "imap", api });
    await type(".wizard-field:nth-child(1) input", "pat@fastmail.com");
    await clickText("Find settings");
    await settle();
    expect(text()).toContain("Found imap.fastmail.com");
    await type('input[type="password"]', "app-password");
    await clickText("Connect");
    await settle();
    expect(calls.find((c) => c.name === "add")?.args[0]).toEqual({
      provider: "imap",
      address: "pat@fastmail.com",
      auth: { kind: "password", user: "pat@fastmail.com", password: "app-password" },
      endpoint: {
        kind: "imap",
        imap: { host: "imap.fastmail.com", port: 993, tls: "tls" },
        smtp: { host: "smtp.fastmail.com", port: 465, tls: "tls" },
      },
    });
    expect(added).toHaveLength(1);
  });

  test("IMAP routes a Google-hosted domain to the Google wizard", async () => {
    const { api } = fakeApi({
      discover: () => ({
        kind: "needs-oauth",
        issuer: "google",
        imap: { host: "imap.gmail.com", port: 993, tls: "tls" },
        smtp: { host: "smtp.gmail.com", port: 465, tls: "tls" },
      }),
    });
    await mount({ initial: "imap", api });
    await type(".wizard-field:nth-child(1) input", "pat@acme.test");
    await clickText("Find settings");
    await settle();
    expect(text()).toContain("This mailbox only signs in through Google.");
    await clickText("Next");
    expect(text()).toContain("Connect Google");
    expect(step()).toBe("project");
  });

  test("IMAP falls back to manual entry", async () => {
    const { api } = fakeApi();
    await mount({ initial: "imap", api });
    await type(".wizard-field:nth-child(1) input", "pat@nowhere.test");
    await clickText("Find settings");
    await settle();
    expect(text()).toContain("Enter the servers by hand.");
    expect(document.querySelectorAll(".wizard-field input").length).toBeGreaterThan(3);
  });

  test("JMAP pastes a token", async () => {
    const { api, calls } = fakeApi();
    await mount({ initial: "jmap", api });
    await type(".wizard-field:nth-child(1) input", "pat@fastmail.com");
    await type(".wizard-field:nth-child(3) input", "fmu1-token");
    await clickText("Connect");
    await settle();
    expect(calls.find((c) => c.name === "add")?.args[0]).toEqual({
      provider: "jmap",
      address: "pat@fastmail.com",
      auth: { kind: "token", token: "fmu1-token" },
      endpoint: { kind: "jmap", sessionUrl: "https://api.fastmail.com/jmap/session" },
    });
  });
});
