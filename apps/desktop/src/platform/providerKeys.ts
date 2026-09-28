// Provider keys on this Device (ADR 0007): kept in the OS keychain through the
// platform seam, one entry per key provider (the language models and
// TypeSafe, ADR 0012), never in the Store or the Config file. The share switch sends a copy to the Server, where it is stored
// under the envelope; unsharing forgets the Server copy and keeps this one.
//
// `resolver` has the shape the Hosted runtime takes for its keys, so a Task
// run on this Device with a Device key resolves the same way as on the Server.

import type { KeyProvider } from "@monday/shared";
import { KEY_PROVIDERS } from "@monday/shared";
import type { Api } from "./api.ts";
import type { Platform } from "./tauri.ts";

const secretName = (provider: KeyProvider) => `monday.provider-key.${provider}`;

export interface DeviceProviderKeys {
  get(provider: KeyProvider): Promise<string | null>;
  set(provider: KeyProvider, key: string): Promise<void>;
  remove(provider: KeyProvider): Promise<void>;
  /** The runtime's key resolver over this Device's keychain. */
  resolver(provider: KeyProvider): Promise<string | null>;
  /** "Let the server use this key": sends the Device key for `provider` to the Server. */
  share(api: Pick<Api, "keys">, workspaceId: string, provider: KeyProvider): Promise<boolean>;
  /** Forgets the Server copy; the Device copy stays. */
  unshare(api: Pick<Api, "keys">, provider: KeyProvider): Promise<void>;
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

/**
 * On start, and whenever the Server changes: every provider whose share
 * Setting is on and whose key is in this Device's keychain but not on the
 * Server is shared again. A key saved while the switch was off by default, or
 * a Server that lost its copy (a new Sidecar database), gets it without the
 * user entering it again. A switch the user turned off stays off. Returns the
 * providers it shared; a failure for one provider does not stop the others.
 */
export async function reconcileSharedKeys(options: {
  keys: Pick<DeviceProviderKeys, "get" | "share">;
  api: Pick<Api, "keys">;
  workspaceId: string;
  /** Whether `ai.share_key.<provider>` is on. */
  wantsShare: (provider: KeyProvider) => boolean;
  log?: ((line: string) => void) | undefined;
}): Promise<KeyProvider[]> {
  const { keys, api, workspaceId, wantsShare } = options;
  const onServer = new Set((await api.keys.shared()).shared);
  const done: KeyProvider[] = [];
  for (const provider of KEY_PROVIDERS) {
    if (!wantsShare(provider) || onServer.has(provider)) continue;
    try {
      if (!(await keys.get(provider))) continue;
      if (await keys.share(api, workspaceId, provider)) done.push(provider);
    } catch (error) {
      options.log?.(
        `share ${provider} key: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return done;
}
