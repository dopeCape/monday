/// <reference types="bun-types" />
// Slice 24's "done when", end to end through the interfaces: a TypeSafe key
// pasted on onboarding's runtime step goes through the real desktop client to
// the Server's POST /keys/typesafe/validate, where the real validator asks
// TypeSafe's models endpoint (a fake fetch here), lands in the Device keychain
// under monday.provider-key.typesafe through the real keychain seam over the
// fake platform, is shared to the Server under the envelope because the card's
// switch starts on, and a Judgment on the fixture Thread (the fake judge on the
// Server side) appears in the Meter under judge.route with provider typesafe,
// read back through the same client.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Account, Capabilities, KeyProvider } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createApp } from "../../../server/src/app.ts";
import { createAuth } from "../../../server/src/auth/index.ts";
import { randomKey } from "../../../server/src/crypto/aead.ts";
import { createKeys } from "../../../server/src/crypto/keys.ts";
import { createIntelligence, type Intelligence } from "../../../server/src/intelligence/index.ts";
import {
  createFakeChat,
  createFakeJudge,
} from "../../../server/src/intelligence/runtime/fake/index.ts";
import { validateTypeSafeKey } from "../../../server/src/intelligence/runtime/typesafe.ts";
import { createMailstore, type Mailstore } from "../../../server/src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "../../../server/test/harness.ts";
import { createApi } from "../platform/api.ts";
import { deviceProviderKeys } from "../platform/providerKeys.ts";
import { fakePlatform } from "../platform/tauri.ts";
import { StaticShell, useShell } from "../shell/Shell.tsx";
import { Onboarding } from "./Onboarding.tsx";

const TOKEN = "per-launch-token";
const NOW = new Date("2026-09-19T10:00:00Z");
const GOOD_KEY = "ts-live-0123456789abcdef";

const account: Account = {
  id: "acct-ts",
  provider: "imap",
  address: "sam@monday.test",
  displayName: "Sam",
  capabilities: {
    push: false,
    labels: false,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
  },
};

let createRoot: Awaited<ReturnType<typeof dom>>["createRoot"];
let root: Root | null = null;
let host: HTMLElement | null = null;
let captured: ReturnType<typeof useShell> | null = null;
function Capture() {
  captured = useShell();
  return null;
}

const settle = () => act(async () => Bun.sleep(30));
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
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
async function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error("no input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("onboarding with a TypeSafe key, end to end (slice 24)", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let intelligence: Intelligence;
  let app: ReturnType<typeof createApp>;
  let workspaceId = "";
  let threadId = "";
  /** What TypeSafe's API saw: the validator's GET /v1/models calls with their bearer. */
  const typesafeSaw: Array<{ url: string; bearer: string | null }> = [];
  const judge = createFakeJudge({ group: "hiring", needs_reply: 0.84 });

  beforeAll(async () => {
    ({ createRoot } = await dom());
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    intelligence = createIntelligence({
      db: db.handle.db,
      mailstore: store,
      chat: createFakeChat("").chat,
      judge: judge.judge,
      // The real validator over TypeSafe's models endpoint, answered by a fake fetch.
      validateKey: (provider, key) =>
        provider === "typesafe"
          ? validateTypeSafeKey(key, {
              fetch: async (url, init) => {
                const headers = init?.headers as Record<string, string> | undefined;
                const bearer = headers?.authorization ?? null;
                typesafeSaw.push({ url, bearer });
                return bearer === `Bearer ${GOOD_KEY}`
                  ? new Response(
                      JSON.stringify({
                        models: [
                          { name: "jev-latest", description: "", release_date: "2026-08-01" },
                        ],
                      }),
                      { status: 200, headers: { "content-type": "application/json" } },
                    )
                  : new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 });
              },
            })
          : Promise.resolve(null),
      level: async () => "automate",
      now: () => NOW,
    });
    app = createApp({
      db: db.handle.db,
      auth: createAuth({ db: db.handle.db, sidecarToken: TOKEN }),
      mode: "sidecar",
      keys,
      mailstore: store,
      intelligence,
      remoteAddress: () => "127.0.0.1",
    });
    workspaceId = (await store.createWorkspace(account)).id;
    threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: "thr-aoife",
      subject: "Take-home submitted",
      participants: [{ name: "Aoife Byrne", email: "aoife@northwind.test" }],
      lastActivity: "2026-09-18T12:00:00.000Z",
    });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  test("a TypeSafe key pasted in onboarding is validated through the Server route, stored in the device keychain, shared to the Server under the envelope, and a Judgment on a fixture Thread appears in the Meter under judge.route with provider typesafe", async () => {
    // The real client over the Server's handler; the real keychain seam over the fake platform.
    const api = createApi(() => ({ baseUrl: "http://server.test", token: TOKEN }), {
      fetch: async (url, init) => app.request(url, init),
    });
    const platform = fakePlatform();
    const keychain = deviceProviderKeys(platform);

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const r = root;
    await act(async () =>
      r.render(
        <StaticShell settings={{ "ai.level": "off" }} shell={{ api }}>
          <Capture />
          <Onboarding
            accountId={account.id}
            workspaceId={workspaceId}
            address={account.address}
            agentClient={null}
            runtimes={{ detect: async () => [] }}
            keys={keychain}
            senders={["Aoife Byrne"]}
            threadCount={1}
            screenWidth={1440}
            now={NOW}
            onDone={() => {}}
          />
        </StaticShell>,
      ),
    );
    await settle();

    // Mail that sorts and acts for me, with nothing configured: the runtime step.
    await click(q('.choice-card[data-value="automate"]'));
    await clickText("Continue");
    expect(q('[data-screen="onboarding"]')?.dataset.step).toBe("runtime");
    await click(q('[data-panel="runtime-step"] .choice-card[data-value="typesafe"]'));
    const row = q('[data-setting="ai.share_key.typesafe"]');
    expect(row?.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");

    // A wrong key: TypeSafe's models endpoint refuses it through the Server, nothing is stored.
    await clickText("Add key", row ?? document);
    await type(row?.querySelector<HTMLInputElement>("input") ?? null, "ts-wrong");
    await clickText("Save", row ?? document);
    expect(typesafeSaw).toEqual([
      { url: "https://api.typesafe.ai/v1/models", bearer: "Bearer ts-wrong" },
    ]);
    expect(row?.textContent).toContain("TypeSafe does not know this key.");
    expect(await platform.secretGet("monday.provider-key.typesafe")).toBeNull();
    expect(await intelligence.keys.list()).toEqual([]);

    // The right key: validated live, into the keychain, shared under the envelope, the Setting on.
    await type(row?.querySelector<HTMLInputElement>("input") ?? null, GOOD_KEY);
    await clickText("Save", row ?? document);
    expect(typesafeSaw.at(-1)).toEqual({
      url: "https://api.typesafe.ai/v1/models",
      bearer: `Bearer ${GOOD_KEY}`,
    });
    expect(await platform.secretGet("monday.provider-key.typesafe")).toBe(GOOD_KEY);
    expect(await intelligence.keys.list()).toEqual(["typesafe" satisfies KeyProvider]);
    expect(await intelligence.keys.load("typesafe")).toBe(GOOD_KEY);
    const rows = await db.handle.sql<
      { data_enc: Uint8Array }[]
    >`select data_enc from provider_keys`;
    expect(Buffer.from(rows[0]?.data_enc ?? []).toString("latin1")).not.toContain(GOOD_KEY);
    expect(captured?.settings["ai.share_key.typesafe"]).toBe(true);
    expect(document.body.textContent).not.toContain(GOOD_KEY);
    const caps = (await (
      await app.request("/capabilities", { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json()) as Capabilities;
    expect(caps.hosted.sharedKeys).toEqual(["typesafe"]);
    expect(caps.hosted.judge).toEqual({ provider: "typesafe", model: "jev-1.13.0" });

    // Sorting runs on TypeSafe alone: Continue is allowed, and the level lands.
    expect(q('[data-panel="runtime-step"] [data-note]')?.textContent).toContain(
      "TypeSafe alone sorts.",
    );
    const cont = qa<HTMLButtonElement>('[data-panel="runtime-step"] button').find(
      (b) => b.textContent?.trim() === "Continue",
    );
    expect(cont?.disabled).toBe(false);
    await click(cont);
    expect(captured?.settings["ai.level"]).toBe("automate");

    // The Server judges the fixture Thread with the shared key; the Meter shows it as its own line.
    expect(await intelligence.runtime.judgeAvailable()).toBe(true);
    const result = await intelligence.runtime.judge(
      "judge.route",
      { threadId, subject: "Take-home submitted", from: "aoife@northwind.test" },
      {
        group: {
          type: "choice",
          instructions: "Which Group does this Thread belong to?",
          criteria: { hiring: "candidates", finance: "money" },
        },
        needs_reply: { type: "noul", instructions: "A person is waiting on the owner." },
      },
      { workspaceId },
    );
    expect(result.answers.group.choice).toBe("hiring");
    expect(result.answers.needs_reply.noul).toBe(0.84);
    const month = await api.meter.month(workspaceId, "2026-09");
    expect(month.lines).toEqual([
      {
        task: "judge.route",
        provider: "typesafe",
        calls: 1,
        inputTokens: result.usage.inputTokens,
        outputTokens: 0,
        cachedTokens: 0,
        costMicros: result.costMicros,
      },
    ]);
    expect(month.costMicros).toBe(result.costMicros);
  }, 60_000);
});
