// Provider keys on this Device (ADR 0007): kept in the OS keychain through the
// platform seam, one entry per Hosted provider, never in the Store or the
// Config file. The share switch sends a copy to the Server, where it is stored
// under the envelope; unsharing forgets the Server copy and keeps this one.
//
// `resolver` has the shape the Hosted runtime takes for its keys, so a Task
// run on this Device with a Device key resolves the same way as on the Server.

import type { HostedProvider } from "@monday/shared";
import type { Api } from "./api.ts";
import type { Platform } from "./tauri.ts";

const secretName = (provider: HostedProvider) => `monday.provider-key.${provider}`;

export interface DeviceProviderKeys {
  get(provider: HostedProvider): Promise<string | null>;
  set(provider: HostedProvider, key: string): Promise<void>;
  remove(provider: HostedProvider): Promise<void>;
  /** The runtime's key resolver over this Device's keychain. */
  resolver(provider: HostedProvider): Promise<string | null>;
  /** "Let the server use this key": sends the Device key for `provider` to the Server. */
  share(api: Api, workspaceId: string, provider: HostedProvider): Promise<boolean>;
  /** Forgets the Server copy; the Device copy stays. */
  unshare(api: Api, provider: HostedProvider): Promise<void>;
}

export function deviceProviderKeys(
  platform: Pick<Platform, "secretGet" | "secretSet" | "secretDelete">,
): DeviceProviderKeys {
  const keys: DeviceProviderKeys = {
    get: (provider) => platform.secretGet(secretName(provider)),
    set: (provider, key) => platform.secretSet(secretName(provider), key),
    remove: (provider) => platform.secretDelete(secretName(provider)),
    resolver: (provider) => keys.get(provider),
    async share(api, workspaceId, provider) {
      const key = await keys.get(provider);
      if (!key) return false;
      await api.keys.share(workspaceId, provider, key);
      return true;
    },
    unshare: (api, provider) => api.keys.unshare(provider),
  };
  return keys;
}
