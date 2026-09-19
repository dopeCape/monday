/// <reference types="bun-types" />
// The Settings screens through the DOM with happy-dom (docs/spec/settings.md,
// slice 17): every control on every page comes from the schema and every
// schema key lands on exactly one page; a Pinned key is locked with the file
// line; a change writes through with Undo from the toast; "Ask monday" inputs
// hand their text to the composer; the Devices, Storage, Meter and Activity
// log panels over a scripted Api; and the Agent's change_setting tool (the
// Server's own tool server over a fake ToolHost) changing one key per section
// with the rendered control following after shell.refresh().

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  type ActivityRecord,
  type Device,
  type ExternalConsent,
  type ExternalCredential,
  type HostedProvider,
  isSettingKey,
  isStringKey,
  type MeterMonth,
  SETTING_SECTIONS,
  type SettingEntry,
  type SettingKey,
  settingKeys,
  settingsSchema,
  type VoiceProfile,
} from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createMemoryActivityLog } from "../../../server/src/intelligence/agent/activity.ts";
import { createFakeToolHost } from "../../../server/src/intelligence/agent/tools/fake-host.ts";
import { createToolServer } from "../../../server/src/intelligence/agent/tools/index.ts";
import { type Api, createApi, type PendingPairings } from "../platform/api.ts";
import type { DeviceProviderKeys } from "../platform/providerKeys.ts";
import { type ShellState, StaticShell, useShell } from "../shell/Shell.tsx";
import { Settings, type SettingsProps } from "./Settings.tsx";
import { controlKinds } from "./settings/render.tsx";

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

const NOW = new Date("2026-09-17T10:00:00Z");
const settle = () => act(async () => Bun.sleep(15));
const q = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const qa = <T extends Element = HTMLElement>(selector: string) => [
  ...document.querySelectorAll<T>(selector),
];
const text = () => document.body.textContent ?? "";

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => (el as HTMLElement).click());
  await settle();
}

async function clickText(label: string, within: ParentNode = document) {
  const el = [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => (b.textContent ?? "").trim() === label,
  );
  if (!el) throw new Error(`no button ${label}`);
  await click(el);
}

async function type(input: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!input) throw new Error("no input");
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function blur(input: Element | null) {
  if (!input) throw new Error("no input");
  await act(async () => input.dispatchEvent(new FocusEvent("blur", { bubbles: false })));
  // React listens to focusout for onBlur.
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await settle();
}

/* ------------------------------ A scripted Server ------------------------------ */

interface Scripted {
  api: Api;
  calls: Array<{ name: string; args: unknown[] }>;
  stored: Record<string, unknown>;
}

function scriptedApi(
  over: {
    devices?: Device[];
    me?: string;
    pending?: PendingPairings;
    meter?: MeterMonth;
    activity?: ActivityRecord[];
    voice?: VoiceProfile;
    stored?: Record<string, unknown>;
    shared?: HostedProvider[];
    credentials?: ExternalCredential[];
    consents?: ExternalConsent[];
  } = {},
): Scripted {
  const calls: Scripted["calls"] = [];
  const stored = over.stored ?? {};
  const base = createApi(() => ({ baseUrl: "http://127.0.0.1:4242", token: "t" }));
  const api: Api = {
    ...base,
    health: async () => ({ ok: true, mode: "sidecar", uptimeMs: 1 }),
    capabilities: async () => {
      throw new Error("no capabilities scripted");
    },
    upgrade: {
      ...base.upgrade,
      status: async () => {
        throw new Error("no upgrade scripted");
      },
    },
    accounts: {
      ...base.accounts,
      list: async () => ({
        accounts: [
          {
            id: "a1",
            workspaceId: "ws-1",
            provider: "jmap",
            address: "tejas@genai-labs.io",
            displayName: "Tejas",
            capabilities: {
              push: true,
              labels: true,
              snooze: false,
              mute: false,
              calendar: false,
              meetingLink: null,
            },
            connected: true,
            lastSync: "2026-09-17T09:59:00Z",
            lastError: null,
          },
        ],
      }),
    },
    settings: {
      all: async () => ({ global: { ...stored }, device: {} }),
      set: async (key, value, scope) => {
        calls.push({ name: "settings.set", args: [key, value, scope] });
        stored[key] = value;
        return { key, value, scope };
      },
    },
    devices: {
      list: async () => over.devices ?? [],
      me: async () => ({ id: over.me ?? "d1", kind: "device" as const }),
      pending: async () => over.pending ?? { pending: [], setupAvailable: false },
      revoke: async (id) => {
        calls.push({ name: "revoke", args: [id] });
        return new Response(null, { status: 204 });
      },
      confirm: async (code) => {
        calls.push({ name: "confirm", args: [code] });
        return { ok: true };
      },
    },
    storage: async () => ({ messages: 12418, bytes: 1.9 * 1024 * 1024 * 1024 }),
    meter: {
      month: async () =>
        over.meter ?? { workspaceId: "ws-1", month: "2026-09", lines: [], costMicros: 0 },
    },
    voice: {
      get: async () =>
        over.voice ?? {
          workspaceId: "ws-1",
          description: "Short and warm.",
          excerpts: ["a", "b"],
          builtAt: "2026-09-10T10:00:00Z",
          enabled: true,
        },
      put: async (_ws, patch) => {
        calls.push({ name: "voice.put", args: [patch] });
        return { ...(over.voice ?? (await api.voice.get("ws-1"))), ...patch } as VoiceProfile;
      },
    },
    keys: {
      shared: async () => ({ shared: over.shared ?? [] }),
      share: async (_ws, provider, key) => {
        calls.push({ name: "keys.share", args: [provider, key] });
        return { provider, shared: true };
      },
      unshare: async (provider) => {
        calls.push({ name: "keys.unshare", args: [provider] });
      },
    },
    routing: {
      ...base.routing,
      groups: async () => [
        {
          id: "g-hiring",
          workspaceId: "ws-1",
          parentId: null,
          name: "Hiring",
          rule: { sentence: "Anything about candidates", predicate: {}, prompt: "" },
          threshold: null,
          briefPolicy: null,
          examples: [],
          threads: 7,
          unread: 2,
          confidence: 0.9,
        },
      ],
    },
    agent: {
      ...base.agent,
      activity: async () => ({ activity: [...(over.activity ?? [])] }),
      undo: async (id, session) => {
        calls.push({ name: "agent.undo", args: [id, session] });
        const row = over.activity?.find((r) => r.id === id);
        if (!row) throw new Error("no row");
        row.undoneAt = NOW.toISOString();
        return row;
      },
    },
    external: {
      ...base.external,
      credentials: async () => over.credentials ?? [],
      createKey: async (input) => {
        calls.push({ name: "external.createKey", args: [input] });
        return {
          credential: {
            id: "c-new",
            kind: "key",
            name: input.name,
            scope: input.scope,
            workspaceIds: input.workspaceIds,
            createdAt: NOW.toISOString(),
            expiresAt: "2026-12-16T10:00:00Z",
            lastUsedAt: null,
            revokedAt: null,
            clientId: null,
            prefix: "mk_live_abcdef",
          },
          secret: "mk_live_abcdef0123456789",
        };
      },
      revoke: async (id) => {
        calls.push({ name: "external.revoke", args: [id] });
      },
      consents: async () => over.consents ?? [],
      approveConsent: async (ref, workspaceIds) => {
        calls.push({ name: "external.approve", args: [ref, workspaceIds] });
        const found = over.consents?.[0];
        if (!found) throw Object.assign(new Error("not found"), { status: 404 });
        return found;
      },
      denyConsent: async (id) => {
        calls.push({ name: "external.deny", args: [id] });
      },
      pending: async () => [],
      live: () => () => {},
      decide: async () => {
        throw new Error("not scripted");
      },
    },
  };
  return { api, calls, stored };
}

/** A keychain of provider keys for the tests: set, get, remove, share through the api. */
function fakeKeys(initial: Partial<Record<HostedProvider, string>> = {}) {
  const store = new Map<HostedProvider, string>(
    Object.entries(initial) as Array<[HostedProvider, string]>,
  );
  const keys: DeviceProviderKeys & { writes: string[] } = {
    writes: [],
    get: async (p) => store.get(p) ?? null,
    set: async (p, k) => {
      store.set(p, k);
      keys.writes.push(`${p}:${k}`);
    },
    remove: async (p) => {
      store.delete(p);
    },
    resolver: async (p) => store.get(p) ?? null,
    share: async (api, ws, p) => {
      const k = store.get(p);
      if (!k) return false;
      await api.keys.share(ws, p, k);
      return true;
    },
    unshare: (api, p) => api.keys.unshare(p),
  };
  return keys;
}

let captured: ShellState | null = null;
function Capture() {
  captured = useShell();
  return null;
}

async function mount(
  props: Partial<SettingsProps> = {},
  shell: Partial<Pick<ShellState, "api" | "pinned" | "config" | "sidecar" | "server">> = {},
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  const asked: string[] = [];
  await act(async () =>
    r.render(
      <StaticShell shell={shell}>
        <Capture />
        <Settings
          workspaceId="ws-1"
          now={() => NOW}
          onAsk={(t) => asked.push(t)}
          keys={props.keys ?? fakeKeys()}
          {...props}
        />
      </StaticShell>,
    ),
  );
  await settle();
  return { asked };
}

/* ------------------------------ Coverage ------------------------------ */

describe("Settings pages come from the schema", () => {
  test("every control's data-setting is a schema key, and every non-string key renders on exactly one page", async () => {
    const seen = new Map<string, Set<string>>();
    for (const section of SETTING_SECTIONS) {
      await mount({ initialSection: section }, { api: scriptedApi().api });
      const page = q(".settings-in");
      expect(page?.dataset.section).toBe(section);
      const keys = qa("[data-setting]").map((el) => el.getAttribute("data-setting") ?? "");
      // About holds only strings, so its page is one panel and no control.
      expect(keys.length > 0 || qa("[data-panel]").length > 0, section).toBe(true);
      for (const key of keys) {
        expect(isSettingKey(key), `${section}: ${key}`).toBe(true);
        const pages = seen.get(key) ?? new Set<string>();
        pages.add(section);
        seen.set(key, pages);
      }
      // Nothing on the page is a control outside the schema: every input, switch,
      // select, segmented control and swatch sits inside a data-setting row or a panel.
      for (const el of qa("input, textarea, select, .switch, .seg, .sw")) {
        const inside = el.closest("[data-setting], [data-panel], .settings-nav");
        expect(inside, `${section}: ${el.outerHTML.slice(0, 80)}`).not.toBeNull();
      }
      if (root) await act(async () => root?.unmount());
      root = null;
      host?.remove();
      host = null;
    }
    for (const key of settingKeys) {
      const entry = settingsSchema[key] as SettingEntry;
      if (isStringKey(key) || entry.hidden) {
        expect(seen.has(key), key).toBe(false);
        continue;
      }
      const pages = seen.get(key);
      expect(pages?.size, `${key} on ${[...(pages ?? [])].join(", ")}`).toBe(1);
      expect([...(pages ?? [])][0], key).toBe(entry.section);
    }
    // Every special control the schema names has a registered renderer.
    for (const key of settingKeys) {
      const control = (settingsSchema[key] as SettingEntry).control;
      if (control) expect(controlKinds[control], `${key}: ${control}`).toBeDefined();
    }
  });

  test("a Pinned key is locked with the file value and the line it is set on", async () => {
    const file = {
      path: "~/.config/monday/monday.toml",
      exists: true,
      text: '# my rice\n[appearance]\nmode = "dark"\n',
    };
    await mount(
      { initialSection: "appearance" },
      {
        pinned: new Set<SettingKey>(["appearance.mode"]),
        config: { file, values: { "appearance.mode": "dark" }, warnings: [], error: null },
      },
    );
    const row = q('[data-setting="appearance.mode"]');
    expect(row?.dataset.pinned).toBe("true");
    expect(row?.textContent).toContain("set in monday.toml");
    const lock = row?.querySelector<HTMLElement>(".pinned");
    expect(lock?.title).toBe('Set in ~/.config/monday/monday.toml, line 3: mode = "dark"');
    // The control is inert: clicking Light changes nothing.
    await clickText("Light", row ?? document);
    expect(captured?.settings["appearance.mode"]).toBe("system");
  });

  test("a change applies at once and the toast undoes it", async () => {
    const { api } = scriptedApi();
    await mount({ initialSection: "appearance" }, { api });
    const row = q('[data-setting="appearance.mode"]');
    await clickText("Dark", row ?? document);
    expect(captured?.settings["appearance.mode"]).toBe("dark");
    expect(q(".toast")?.textContent).toContain("Mode changed");
    await clickText("Undo Z", q(".toast") ?? document);
    expect(captured?.settings["appearance.mode"]).toBe("system");
    expect(q(".toast")?.textContent).toContain("Undone");

    // A number commits on blur through the schema's range.
    const size = q<HTMLInputElement>('[data-setting="appearance.font_size"] input');
    await type(size, "16");
    await blur(size);
    expect(captured?.settings["appearance.font_size"]).toBe(16);
    await type(size, "99");
    await blur(size);
    expect(captured?.settings["appearance.font_size"]).toBe(16);
    expect(q('[data-setting="appearance.font_size"] .err')?.textContent).toContain("Not saved");

    // A preset writes the three knobs as one change, and its Undo restores them.
    await clickText("Agent left", q('[data-setting="layout.preset"]') ?? document);
    expect(captured?.layout).toEqual({ nav: "rail", agent: "left", list: "split" });
    await clickText("Undo Z", q(".toast") ?? document);
    expect(captured?.layout).toEqual({ nav: "full", agent: "bottom", list: "stream" });
  });

  test("Ask monday inputs hand their text to the composer, and Fix with monday carries the warnings", async () => {
    const { asked } = await mount(
      { initialSection: "appearance" },
      {
        config: {
          file: { path: "monday.toml", exists: true, text: "[appearance]\nmod = 1\n" },
          values: {},
          warnings: [{ line: 2, key: "appearance.mod", message: "unknown key" }],
          error: null,
        },
      },
    );
    expect(text()).toContain("Line 2: unknown key");
    await clickText("Fix with monday");
    expect(asked[0]).toContain("line 2: unknown key");

    const ask = q<HTMLInputElement>('[data-setting="views.list"] .set-ask input');
    await type(ask, "no nav, agent on the right");
    await clickText("Ask", q('[data-setting="views.list"]') ?? document);
    expect(asked[1]).toBe("Make me a view: no nav, agent on the right");
  });

  test("Section rules rename, hide and reorder through their Settings", async () => {
    await mount({ initialSection: "routing" }, { api: scriptedApi().api });
    const rules = q('[data-setting="sections.rules"]');
    expect(rules?.querySelector('[data-setting="sections.order"]')).not.toBeNull();
    await click(q('[data-rule="fyi"] button[aria-label="Up"]'));
    expect(captured?.settings["sections.order"]).toEqual([
      "needs-reply",
      "fyi",
      "waiting",
      "newsletters",
    ]);
    await click(q('[data-rule="newsletters"] .switch'));
    expect(captured?.settings["sections.rules"].find((r) => r.id === "newsletters")?.hidden).toBe(
      true,
    );
    await clickText("Rename", q('[data-rule="needs-reply"]') ?? document);
    const input = q<HTMLInputElement>('[data-rule="needs-reply"] input');
    await type(input, "Reply today");
    await blur(input);
    expect(captured?.settings["strings.section.needs-reply"]).toBe("Reply today");
    // The Groups tree is read-only and shows counts.
    expect(q('[data-group-id="g-hiring"]')?.textContent).toContain("7 threads, 0 examples");
  });
});

/* ------------------------------ AI and agent ------------------------------ */

describe("Settings › AI and agent", () => {
  test("keys are added and shared without ever being displayed", async () => {
    const scripted = scriptedApi();
    const keys = fakeKeys();
    await mount({ initialSection: "ai", keys }, { api: scripted.api });
    const row = q('[data-setting="ai.share_key.anthropic"]');
    expect(row?.textContent).toContain("No key on this device");
    await clickText("Add key", row ?? document);
    const input = row?.querySelector<HTMLInputElement>("input");
    expect(input?.type).toBe("password");
    await type(input ?? null, "sk-ant-secret");
    await clickText("Save", row ?? document);
    expect(keys.writes).toEqual(["anthropic:sk-ant-secret"]);
    expect(text()).not.toContain("sk-ant-secret");
    expect(row?.textContent).toContain("Key set");
    // The share switch sends the Device key and flips the Setting.
    await click(row?.querySelector(".switch"));
    expect(scripted.calls).toContainEqual({
      name: "keys.share",
      args: ["anthropic", "sk-ant-secret"],
    });
    expect(captured?.settings["ai.share_key.anthropic"]).toBe(true);
    // Sharing with no key on the Device is refused with the reason.
    const gemini = q('[data-setting="ai.share_key.gemini"]');
    await click(gemini?.querySelector(".switch"));
    expect(captured?.settings["ai.share_key.gemini"]).toBe(false);
    expect(gemini?.textContent).toContain("No key on this device");
  });

  test("the task map, the tier list, the Meter and the Activity log", async () => {
    const activity: ActivityRecord[] = [
      {
        id: "act-1",
        workspaceId: "ws-1",
        sessionId: "s1",
        runId: null,
        tool: "archive_threads",
        tier: "reversible",
        inputSummary: "2 threads",
        status: "done",
        approvedBy: null,
        result: "Archived 2 threads",
        undoable: true,
        actor: "agent",
        callId: "c1",
        input: null,
        preview: null,
        decision: "auto",
        undoneAt: null,
        at: "2026-09-17T09:00:00Z",
      },
      {
        id: "act-2",
        workspaceId: "ws-1",
        sessionId: "s1",
        runId: null,
        tool: "send_draft",
        tier: "always-ask",
        inputSummary: "To Aoife",
        status: "done",
        approvedBy: "user",
        undoable: false,
        actor: "agent",
        callId: "c2",
        input: null,
        preview: null,
        decision: "approved",
        undoneAt: null,
        at: "2026-09-17T09:30:00Z",
      },
    ];
    const scripted = scriptedApi({
      activity,
      meter: {
        workspaceId: "ws-1",
        month: "2026-09",
        lines: [
          {
            task: "brief",
            provider: "anthropic",
            calls: 12,
            inputTokens: 30_000,
            outputTokens: 4_000,
            cachedTokens: 0,
            costMicros: 120_000,
          },
        ],
        costMicros: 120_000,
      },
    });
    await mount({ initialSection: "ai" }, { api: scripted.api });

    // Every Task has a row; promoting draft_message to always-ask writes the Setting.
    expect(qa('[data-setting^="ai.task."]')).toHaveLength(9);
    await clickText("Fast", q('[data-setting="ai.task.composer"]') ?? document);
    expect(captured?.settings["ai.task.composer"].role).toBe("fast");
    await click(q('[data-tool="draft_message"] .switch'));
    expect(captured?.settings["agent.always_ask"]).toEqual(["draft_message"]);
    expect(q('[data-tool="send_draft"]')?.textContent).toContain("Always ask");
    expect(q('[data-tool="send_draft"] .switch')).toBeNull();

    // The Meter by Task and provider with the estimate.
    const meter = q('[data-panel="meter"]');
    expect(meter?.textContent).toContain("brief");
    expect(meter?.textContent).toContain("$0.12");

    // The Activity log: searchable, with who approved and Undo where still possible.
    const log = q('[data-panel="activity"]');
    expect(log?.querySelectorAll(".activity-row")).toHaveLength(2);
    expect(q('[data-activity="act-2"]')?.textContent).toContain("Approved by you");
    expect(q('[data-activity="act-2"] button')).toBeNull();
    await type(log?.querySelector<HTMLInputElement>("input") ?? null, "archive");
    expect(log?.querySelectorAll(".activity-row")).toHaveLength(1);
    await clickText("Undo", q('[data-activity="act-1"]') ?? document);
    expect(scripted.calls).toContainEqual({ name: "agent.undo", args: ["act-1", "s1"] });
    expect(q('[data-activity="act-1"]')?.textContent).toContain("Undone");
  });
});

/* ------------------------------ Sync server ------------------------------ */

describe("Settings › AI › External access", () => {
  test("keys and signed-in clients with scope, Workspaces, expiry and last use; revoke; a new key shown once with Copy; a consent approved by code", async () => {
    const scripted = scriptedApi({
      credentials: [
        {
          id: "c1",
          kind: "key",
          name: "assistant",
          scope: "read",
          workspaceIds: ["ws-1"],
          createdAt: "2026-09-01T10:00:00Z",
          expiresAt: "2026-11-30T10:00:00Z",
          lastUsedAt: "2026-09-17T09:00:00Z",
          revokedAt: null,
          clientId: null,
          prefix: "mk_live_zzzzzz",
        },
        {
          id: "c2",
          kind: "oauth",
          name: "Claude Desktop",
          scope: "act",
          workspaceIds: null,
          createdAt: "2026-09-01T10:00:00Z",
          expiresAt: "2026-09-10T10:00:00Z",
          lastUsedAt: null,
          revokedAt: null,
          clientId: "client-1",
          prefix: null,
        },
      ],
      consents: [
        {
          id: "consent-1",
          clientId: "client-1",
          clientName: "Cursor",
          scope: "read",
          workspaceIds: null,
          code: "424242",
          expiresAt: "2026-09-17T10:10:00Z",
        },
      ],
    });
    let answer = false;
    (globalThis as { confirm: (m?: string) => boolean }).confirm = () => answer;
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void copied.push(t) },
    });
    await mount({ initialSection: "ai" }, { api: scripted.api });
    const panel = q('[data-panel="external"]');
    expect(panel).not.toBeNull();
    // The Setting controls of the group render beside the panel, under Advanced.
    expect(q('[data-setting="external.rate_per_minute"]')).not.toBeNull();
    expect(q('[data-setting="external.key_expiry_days"]')).not.toBeNull();

    const key = q('[data-credential="c1"]');
    expect(key?.textContent).toContain("assistant (mk_live_zzzzzz...)");
    expect(key?.textContent).toContain("Key · Read only · 1 workspaces · Last used Today 09:00");
    expect(key?.textContent).toContain("Expires");
    const client = q('[data-credential="c2"]');
    expect(client?.textContent).toContain("Signed in · Read and act, asks first · All workspaces");
    expect(client?.textContent).toContain("Never used");
    expect(client?.textContent).toContain("Expired");

    // Revoke asks first.
    await clickText("Revoke", key ?? document);
    expect(scripted.calls.find((c) => c.name === "external.revoke")).toBeUndefined();
    answer = true;
    await clickText("Revoke", key ?? document);
    expect(scripted.calls).toContainEqual({ name: "external.revoke", args: ["c1"] });

    // A new key: name, scope, expiry; then the secret once, with Copy.
    await clickText("New key", panel ?? document);
    await type(q<HTMLInputElement>("#external-name"), "my assistant");
    await click(
      [...(q('[data-panel="external-new"]')?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent === "Read and act, asks first",
      ),
    );
    await type(q<HTMLInputElement>("#external-days"), "30");
    await clickText("Create key", q('[data-panel="external-new"]') ?? document);
    expect(scripted.calls).toContainEqual({
      name: "external.createKey",
      args: [{ name: "my assistant", scope: "act", workspaceIds: null, expiresInDays: 30 }],
    });
    const shown = q('[data-panel="external-key"]');
    expect(shown?.querySelector<HTMLInputElement>("input[data-secret]")?.value).toBe(
      "mk_live_abcdef0123456789",
    );
    expect(shown?.textContent).toContain("shown once");
    await clickText("Copy", shown ?? document);
    expect(copied).toEqual(["mk_live_abcdef0123456789"]);
    expect(shown?.textContent).toContain("Copied");
    await clickText("Done", shown ?? document);
    expect(q('[data-panel="external-key"]')).toBeNull();

    // An OAuth consent waiting: approved from the list, or by the code the page shows.
    const consent = q('[data-consent="consent-1"]');
    expect(consent?.textContent).toContain("Cursor wants Read only access, code 424242");
    await clickText("Approve", consent ?? document);
    expect(scripted.calls).toContainEqual({
      name: "external.approve",
      args: [{ id: "consent-1" }, null],
    });
    await type(q<HTMLInputElement>("#external-code"), "424242");
    await clickText("Approve", q('[data-panel="external-consents"] .wizard-fields') ?? document);
    expect(scripted.calls).toContainEqual({
      name: "external.approve",
      args: [{ code: "424242" }, null],
    });
    expect(q('[data-panel="external-consents"]')?.textContent).toContain("Approved");
  });
});

describe("Settings › Sync server", () => {
  test("devices with this Device marked, revoke with confirm, pending codes to approve, and storage", async () => {
    const scripted = scriptedApi({
      devices: [
        { id: "d1", name: "Laptop", lastSeen: "2026-09-17T09:59:00Z" },
        { id: "d2", name: "Phone", lastSeen: "2026-09-16T09:00:00Z" },
      ],
      me: "d1",
      pending: {
        pending: [{ code: "123456", name: "Tablet", expiresAt: "2026-09-17T10:10:00Z" }],
        setupAvailable: false,
      },
    });
    const confirms: string[] = [];
    let answer = false;
    (globalThis as { confirm: (m?: string) => boolean }).confirm = (m) => {
      confirms.push(m ?? "");
      return answer;
    };
    await mount(
      { initialSection: "server" },
      {
        api: scripted.api,
        sidecar: { port: 4242, token: "t", running: true },
        server: { kind: "sidecar", target: { baseUrl: "http://127.0.0.1:4242", token: "t" } },
      },
    );
    expect(q('[data-device="d1"]')?.textContent).toContain("This device");
    expect(q('[data-device="d2"]')?.textContent).not.toContain("This device");
    await clickText("Revoke", q('[data-device="d2"]') ?? document);
    expect(confirms[0]).toContain("Phone");
    expect(scripted.calls.find((c) => c.name === "revoke")).toBeUndefined();
    answer = true;
    await clickText("Revoke", q('[data-device="d2"]') ?? document);
    expect(scripted.calls).toContainEqual({ name: "revoke", args: ["d2"] });

    // A code another Device is showing, approved from here.
    expect(q('[data-pending="123456"]')?.textContent).toContain(
      "Tablet asked to pair, code 123456",
    );
    await clickText("Approve a code", q('[data-pending="123456"]') ?? document);
    expect(scripted.calls).toContainEqual({ name: "confirm", args: ["123456"] });

    // The schema-backed Connection controls render beside the panel.
    expect(q('[data-setting="server.prefer"]')).not.toBeNull();
    expect(q('[data-setting="server.insecure_allowed"] .switch')).not.toBeNull();

    // Storage: the count and size, the recovery file from the keychain, and import.
    const storage = q('[data-panel="storage"]');
    expect(storage?.textContent).toContain("12,418 messages, 1.9 GB");
    expect(storage?.textContent).toContain("In the keychain");
    await clickText("Import", storage ?? document);
    await type(storage?.querySelector<HTMLTextAreaElement>("textarea") ?? null, "not a key");
    await clickText("Import", storage?.querySelector(".voice-edit") ?? document);
    expect(storage?.textContent).toContain("not a recovery key");
  });
});

/* ------------------------------ Shortcuts ------------------------------ */

describe("Settings › Shortcuts", () => {
  test("the binding table is grouped, remappable and highlights conflicts", async () => {
    await mount({ initialSection: "shortcuts" }, { api: scriptedApi().api });
    expect(qa(".bindings h4").map((h) => h.textContent)).toEqual([
      "Navigate",
      "Act",
      "Compose",
      "Select",
      "Views",
    ]);
    await clickText("E", q('[data-action="thread.star"]') ?? document).catch(() => {});
    await click(q('[data-action="thread.star"] .chord-btn'));
    const input = q<HTMLInputElement>('[data-action="thread.star"] input');
    await type(input, "e");
    await blur(input);
    expect(captured?.settings["keyboard.bindings"]).toEqual({ "thread.star": "e" });
    expect(q('[data-action="thread.star"]')?.classList.contains("clash")).toBe(true);
    expect(q('[data-action="thread.archive"]')?.textContent).toContain("Also bound to Star");
    // Reset drops the override.
    await click(q('[data-action="thread.star"] button[aria-label="Reset"]'));
    expect(captured?.settings["keyboard.bindings"]).toEqual({});
    // The keymap picker is the Setting.
    await clickText("Gmail", q('[data-setting="keyboard.keymap"]') ?? document);
    expect(captured?.settings["keyboard.keymap"]).toBe("gmail");
    expect(q('[data-action="thread.open"] .kbd')?.textContent).toBe("O");
  });
});

/* ------------------------------ The Agent changes any of them ------------------------------ */

describe("the Agent's change_setting tool reaches every page", () => {
  /** One key per section, the value the Agent sets, and what the rendered control shows. */
  const cases: Array<{
    section: (typeof SETTING_SECTIONS)[number];
    key: SettingKey;
    value: unknown;
    shows: (row: HTMLElement) => boolean;
  }> = [
    {
      section: "accounts",
      key: "send.delay_seconds",
      value: 45,
      shows: (row) => row.querySelector<HTMLInputElement>("input")?.value === "45",
    },
    {
      section: "appearance",
      key: "appearance.density",
      value: "compact",
      shows: (row) => row.querySelector('[aria-pressed="true"]')?.textContent === "Compact",
    },
    {
      section: "routing",
      key: "routing.threshold.route",
      value: 0.9,
      shows: (row) => row.querySelector<HTMLInputElement>("input")?.value === "0.9",
    },
    {
      section: "ai",
      key: "ai.web_fetch",
      value: true,
      shows: (row) => row.querySelector(".switch")?.getAttribute("aria-checked") === "true",
    },
    {
      section: "workflows",
      key: "workflows.placement",
      value: "local",
      shows: (row) => row.querySelector('[aria-pressed="true"]')?.textContent === "Local",
    },
    {
      section: "server",
      key: "search.cache_cap_gb",
      value: 5,
      shows: (row) => row.querySelector<HTMLInputElement>("input")?.value === "5",
    },
    {
      section: "shortcuts",
      key: "keyboard.keymap",
      value: "natural",
      shows: (row) => row.querySelector('[aria-pressed="true"]')?.textContent === "Natural",
    },
  ];

  for (const c of cases) {
    test(`${c.section}: ${c.key}`, async () => {
      // The Server's tool server over a fake ToolHost whose settings the scripted api serves.
      const toolHost = createFakeToolHost([], { now: () => NOW });
      const scripted = scriptedApi();
      const serveHost = () => {
        for (const [k, v] of toolHost.settings) scripted.stored[k] = v;
      };
      const server = createToolServer({
        host: toolHost,
        activity: createMemoryActivityLog({ now: () => NOW }),
        now: () => NOW,
        settings: async () => ({ previewAbove: 10, alwaysAsk: [], searchLimit: 100 }),
      });
      await mount({ initialSection: c.section }, { api: scripted.api });
      const before = q<HTMLElement>(`[data-setting="${c.key}"]`);
      expect(before, c.key).not.toBeNull();
      expect(c.shows(before as HTMLElement)).toBe(false);

      const outcome = await server.call(
        {
          name: "change_setting",
          args: { key: c.key, value: c.value },
          callId: "c1",
          sessionId: "s1",
        },
        { ask: async () => "approved" },
      );
      expect(outcome.isError, outcome.text).toBe(false);
      expect(toolHost.writes).toEqual([{ key: c.key, value: c.value }]);

      serveHost();
      await act(async () => captured?.refresh());
      await settle();
      expect(captured?.settings[c.key]).toEqual(c.value as never);
      const after = q<HTMLElement>(`[data-setting="${c.key}"]`);
      expect(c.shows(after as HTMLElement), c.key).toBe(true);
    });
  }

  test("about: a string Setting changes the rendered telemetry line", async () => {
    const toolHost = createFakeToolHost([], { now: () => NOW });
    const scripted = scriptedApi();
    const server = createToolServer({
      host: toolHost,
      activity: createMemoryActivityLog({ now: () => NOW }),
      now: () => NOW,
      settings: async () => ({ previewAbove: 10, alwaysAsk: [], searchLimit: 100 }),
    });
    await mount({ initialSection: "about" }, { api: scripted.api });
    expect(text()).toContain("monday sends no telemetry.");
    await server.call(
      {
        name: "change_setting",
        args: { key: "strings.about.telemetry", value: "No telemetry, ever." },
        callId: "c1",
        sessionId: "s1",
      },
      { ask: async () => "approved" },
    );
    for (const [k, v] of toolHost.settings) scripted.stored[k] = v;
    await act(async () => captured?.refresh());
    await settle();
    expect(text()).toContain("No telemetry, ever.");
  });
});
