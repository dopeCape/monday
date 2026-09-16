// The Providers module's front door: one Provider per kind. Gmail and Graph
// are slice 9; their slots throw until then so the registry, the sync engine
// and the onboarding code paths already have somewhere to plug in.

import type { Provider as ProviderKind } from "@monday/shared";
import { createImapProvider, type ImapProviderOptions } from "./imap/index.ts";
import { createJmapProvider, type JmapProviderOptions } from "./jmap/index.ts";
import { type Provider, ProviderError } from "./types.ts";

export { discover } from "./autoconfig.ts";
export { createFakeProvider, fakeCredentials, generateFixture } from "./fake/index.ts";
export { createImapProvider } from "./imap/index.ts";
export { createJmapProvider } from "./jmap/index.ts";
export * from "./types.ts";

export interface ProviderRegistryOptions {
  jmap?: JmapProviderOptions;
  imap?: ImapProviderOptions;
  /** Test seam: extra kinds, or overrides for the built-in ones. */
  overrides?: Partial<Record<ProviderKind | "fake", Provider>>;
}

export type ProviderRegistry = (kind: ProviderKind | "fake") => Provider;

function unavailable(kind: ProviderKind): Provider {
  return {
    kind,
    async connect() {
      throw new ProviderError(`${kind} arrives in slice 9`, "unsupported");
    },
  };
}

export function createProviderRegistry(options: ProviderRegistryOptions = {}): ProviderRegistry {
  const builtIn: Record<ProviderKind, Provider> = {
    jmap: createJmapProvider(options.jmap ?? {}),
    imap: createImapProvider(options.imap ?? {}),
    gmail: unavailable("gmail"),
    graph: unavailable("graph"),
  };
  return (kind) => {
    const override = options.overrides?.[kind];
    if (override) return override;
    if (kind === "fake") throw new ProviderError("no fake Provider registered", "unsupported");
    return builtIn[kind];
  };
}
