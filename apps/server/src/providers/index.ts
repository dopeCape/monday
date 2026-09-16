// The Providers module's front door: one Provider per kind. Gmail and Graph
// take the token broker directly so they can refresh mid-Session; JMAP and
// IMAP are wrapped so OAuth credentials (XOAUTH2 for Gmail and Microsoft over
// IMAP) get a live access token before every connect.

import type { Provider as ProviderKind } from "@monday/shared";
import { createGmailProvider, type GmailProviderOptions } from "./gmail/index.ts";
import { createGraphProvider, type GraphProviderOptions } from "./graph/index.ts";
import { createImapProvider, type ImapProviderOptions } from "./imap/index.ts";
import { createJmapProvider, type JmapProviderOptions } from "./jmap/index.ts";
import { createTokenBroker, type TokenBroker, type TokenBrokerOptions } from "./oauth/tokens.ts";
import { type Provider, ProviderError } from "./types.ts";

export { discover } from "./autoconfig.ts";
export { createFakeProvider, fakeCredentials, generateFixture } from "./fake/index.ts";
export { createGmailProvider, isGmailSession } from "./gmail/index.ts";
export { createGraphProvider, isGraphSession } from "./graph/index.ts";
export { createImapProvider } from "./imap/index.ts";
export { createJmapProvider } from "./jmap/index.ts";
export { createTokenBroker, staticTokenBroker, type TokenBroker } from "./oauth/tokens.ts";
export * from "./types.ts";

export interface ProviderRegistryOptions {
  jmap?: JmapProviderOptions;
  imap?: ImapProviderOptions;
  gmail?: GmailProviderOptions;
  graph?: GraphProviderOptions;
  /** One broker for every adapter; built from `oauth` when absent. */
  tokens?: TokenBroker;
  oauth?: TokenBrokerOptions;
  /** Test seam: extra kinds, or overrides for the built-in ones. */
  overrides?: Partial<Record<ProviderKind | "fake", Provider>>;
}

export type ProviderRegistry = (kind: ProviderKind | "fake") => Provider;

/** Refreshes OAuth credentials before connecting, for adapters that take a static token. */
export function withTokenRefresh(provider: Provider, tokens: TokenBroker): Provider {
  return {
    kind: provider.kind,
    async connect(credentials) {
      if (credentials.auth.kind === "oauth") {
        await tokens.access(credentials.auth, { path: "imap" });
      }
      return provider.connect(credentials);
    },
  };
}

export function createProviderRegistry(options: ProviderRegistryOptions = {}): ProviderRegistry {
  const tokens = options.tokens ?? createTokenBroker(options.oauth ?? {});
  const builtIn: Record<ProviderKind, Provider> = {
    jmap: withTokenRefresh(createJmapProvider(options.jmap ?? {}), tokens),
    imap: withTokenRefresh(createImapProvider(options.imap ?? {}), tokens),
    gmail: createGmailProvider({ tokens, ...(options.gmail ?? {}) }),
    graph: createGraphProvider({ tokens, ...(options.graph ?? {}) }),
  };
  return (kind) => {
    const override = options.overrides?.[kind];
    if (override) return override;
    if (kind === "fake") throw new ProviderError("no fake Provider registered", "unsupported");
    return builtIn[kind];
  };
}
