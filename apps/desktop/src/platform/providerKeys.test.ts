import { describe, expect, test } from "bun:test";
import { defaultSettings, type HostedProvider, type KeyProvider } from "@monday/shared";
import type { Api } from "./api.ts";
import { deviceProviderKeys, reconcileSharedKeys } from "./providerKeys.ts";
import { fakePlatform } from "./tauri.ts";

/** Only the key routes, recording what was sent; the Server never echoes a key. */
function fakeKeysApi() {
  const shared: { workspaceId: string; provider: KeyProvider; key: string }[] = [];
  const unshared: HostedProvider[] = [];
  const api = {
    keys: {
      shared: async () => ({ shared: shared.map((s) => s.provider) }),
      share: async (workspaceId: string, provider: KeyProvider, key: string) => {
        shared.push({ workspaceId, provider, key });
        return { provider, shared: true };
      },
      unshare: async (provider: HostedProvider) => {
        unshared.push(provider);
      },
    },
  } as unknown as Api;
  return { api, shared, unshared };
}

describe("device provider keys", () => {
  test("a key lives in the keychain under its provider and resolves for the runtime", async () => {
    const keys = deviceProviderKeys(fakePlatform());
    expect(await keys.get("anthropic")).toBeNull();
    await keys.set("anthropic", "sk-ant-device");
    expect(await keys.get("anthropic")).toBe("sk-ant-device");
    expect(await keys.resolver("anthropic")).toBe("sk-ant-device");
    expect(await keys.resolver("openai")).toBeNull();
    await keys.remove("anthropic");
    expect(await keys.get("anthropic")).toBeNull();
  });

  test("sharing sends the Device key to the Server; unsharing keeps the Device copy", async () => {
    const platform = fakePlatform();
    const keys = deviceProviderKeys(platform);
    const { api, shared, unshared } = fakeKeysApi();
    expect(await keys.share(api, "ws-1", "gemini")).toBe(false);
    expect(shared).toEqual([]);

    await keys.set("gemini", "AIza-device");
    expect(await keys.share(api, "ws-1", "gemini")).toBe(true);
    expect(shared).toEqual([{ workspaceId: "ws-1", provider: "gemini", key: "AIza-device" }]);

    await keys.unshare(api, "gemini");
    expect(unshared).toEqual(["gemini"]);
    expect(await keys.get("gemini")).toBe("AIza-device");
  });
});

describe("sharing keys on start", () => {
  test("a TypeSafe key saved while the switch was off by default reaches the Server on start, without being entered again", async () => {
    const keys = deviceProviderKeys(fakePlatform());
    // The user's case: the key is in the keychain, the Server has none.
    await keys.set("typesafe", "ts-device");
    await keys.set("anthropic", "sk-ant-device");
    await keys.set("openai", "sk-openai-device");
    const { api, shared } = fakeKeysApi();
    const settings = defaultSettings();
    // TypeSafe's share Setting defaults on; Anthropic's is on by the user; OpenAI's stays off.
    const wants = (p: KeyProvider) => (p === "anthropic" ? true : settings[`ai.share_key.${p}`]);
    expect(settings["ai.share_key.typesafe"]).toBe(true);
    expect(settings["ai.share_key.openai"]).toBe(false);
    const done = await reconcileSharedKeys({ keys, api, workspaceId: "ws-1", wantsShare: wants });
    expect(done).toEqual(["anthropic", "typesafe"]);
    expect(shared).toEqual([
      { workspaceId: "ws-1", provider: "anthropic", key: "sk-ant-device" },
      { workspaceId: "ws-1", provider: "typesafe", key: "ts-device" },
    ]);
    // Once the Server has them, the next start sends nothing.
    expect(
      await reconcileSharedKeys({ keys, api, workspaceId: "ws-1", wantsShare: wants }),
    ).toEqual([]);
    expect(shared).toHaveLength(2);
  });

  test("a switch the user turned off stays off, a provider with no Device key is skipped, and one failure does not stop the rest", async () => {
    const keys = deviceProviderKeys(fakePlatform());
    await keys.set("typesafe", "ts-device");
    await keys.set("gemini", "AIza-device");
    const { api, shared } = fakeKeysApi();
    const failing = {
      keys: {
        ...api.keys,
        share: async (workspaceId: string, provider: KeyProvider, key: string) => {
          if (provider === "gemini") throw new Error("423 locked");
          return api.keys.share(workspaceId, provider, key);
        },
      },
    } as unknown as Api;
    const lines: string[] = [];
    const done = await reconcileSharedKeys({
      keys,
      api: failing,
      workspaceId: "ws-1",
      // TypeSafe off by the user; Gemini and Anthropic on, but Anthropic has no key here.
      wantsShare: (p) => p === "gemini" || p === "anthropic",
      log: (l) => lines.push(l),
    });
    expect(done).toEqual([]);
    expect(shared).toEqual([]);
    expect(lines).toEqual(["share gemini key: 423 locked"]);
  });
});
