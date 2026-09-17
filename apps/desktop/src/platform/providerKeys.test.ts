import { describe, expect, test } from "bun:test";
import type { HostedProvider } from "@monday/shared";
import type { Api } from "./api.ts";
import { deviceProviderKeys } from "./providerKeys.ts";
import { fakePlatform } from "./tauri.ts";

/** Only the key routes, recording what was sent; the Server never echoes a key. */
function fakeKeysApi() {
  const shared: { workspaceId: string; provider: HostedProvider; key: string }[] = [];
  const unshared: HostedProvider[] = [];
  const api = {
    keys: {
      shared: async () => ({ shared: shared.map((s) => s.provider) }),
      share: async (workspaceId: string, provider: HostedProvider, key: string) => {
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
