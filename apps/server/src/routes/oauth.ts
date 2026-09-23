// The OAuth routes behind the credential wizards (ADR 0008).
//   GET  /oauth/:provider/validate?clientId=&clientSecret=&tenant=   live check of a pasted registration
//   POST /oauth/:provider/start   {clientId, clientSecret?, tenant?, path?, pubsubTopic?, redirectUri?}
//                                 opens the Sidecar's loopback listener when one exists and
//                                 answers {state, url, redirectUri}; the browser goes to url
//   POST /oauth/:provider/finish  {state, code}   exchanges the code, creates the Account
//   GET  /oauth/:provider/status?state=           pending | done {account} | error {message},
//                                 long-polled by the wizard while the browser is open
//   GET    /oauth/:provider/app   {app}  the saved app, never its secret (hasSecret says one is kept)
//   PUT    /oauth/:provider/app   {clientId, clientSecret?, tenant?, accountType?, projectId?, pubsubTopic?}
//                                 checks the registration live and saves it only when it passes:
//                                 {result, app}; app is null when the check failed
//   PATCH  /oauth/:provider/app   {projectId?, pubsubTopic?}  the extras a later step fills in
//   DELETE /oauth/:provider/app
// The app is app level: every Account of the provider signs in through it, so
// /start without a clientId uses the saved one.
// :provider is the issuer, google or microsoft. `path` picks the API adapter
// (gmail, graph) or the IMAP adapter with XOAUTH2.

import { Hono } from "hono";
import { z } from "zod";
import type { AccountService, AccountView } from "../accounts.ts";
import type { AppEnv } from "../auth/middleware.ts";
import { OAUTH_ENDPOINTS } from "../providers/autoconfig.ts";
import type { FetchLike } from "../providers/jmap/client.ts";
import { createMemoryOAuthAppStore, type OAuthAppStore } from "../providers/oauth/apps.ts";
import type { Finished, OAuthFlow, StartInput } from "../providers/oauth/flow.ts";
import type { OAuthIssuerName } from "../providers/oauth/issuers.ts";
import { validateGoogleClient, validateMicrosoftClient } from "../providers/oauth/validate.ts";
import type { Credentials, OAuthClient } from "../providers/types.ts";
import { parseBody } from "./validate.ts";

/**
 * The Sidecar's loopback receiver (RFC 8252): a one-shot HTTP listener on a
 * random port that catches the browser redirect. Google wants 127.0.0.1 with
 * a path, Entra wants plain localhost, so the provider picks the shape.
 */
export interface LoopbackListener {
  open(provider: OAuthIssuerName): Promise<{
    redirectUri: string;
    /** The redirect's query parameters (code and state, or error). */
    callback: Promise<Record<string, string>>;
    close(): void;
  }>;
}

export interface OAuthRoutesOptions {
  flow: OAuthFlow;
  accounts: AccountService;
  loopback?: LoopbackListener | null;
  fetch?: FetchLike;
  /** How long /status waits before answering pending. */
  statusWaitMs?: number;
  /** The saved OAuth app per provider; an in-memory one when absent. */
  apps?: OAuthAppStore;
}

type Outcome =
  | { status: "pending" }
  | { status: "done"; account: AccountView }
  | { status: "error"; message: string };

const startBody = z.object({
  /** Absent: sign in through the saved app. */
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().optional(),
  tenant: z.string().optional(),
  path: z.enum(["api", "imap"]).default("api"),
  pubsubTopic: z.string().nullable().optional(),
  /** Only when no loopback listener runs (a client that catches the redirect itself). */
  redirectUri: z.string().url().optional(),
});

const appBody = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().nullable().optional(),
  tenant: z.string().nullable().optional(),
  accountType: z.enum(["personal", "work"]).nullable().optional(),
  projectId: z.string().nullable().optional(),
  pubsubTopic: z.string().nullable().optional(),
});

const appPatchBody = z.object({
  projectId: z.string().nullable().optional(),
  pubsubTopic: z.string().nullable().optional(),
});

const finishBody = z.object({ state: z.string().min(1), code: z.string().min(1) });

function providerOf(param: string): OAuthIssuerName | null {
  return param === "google" || param === "microsoft" ? param : null;
}

/** The Credentials an OAuth finish turns into, for the API path or the IMAP path. */
export function credentialsOf(finished: Finished): {
  provider: "gmail" | "graph" | "imap";
  credentials: Credentials;
} {
  if (finished.path === "imap") {
    return {
      provider: "imap",
      credentials: {
        address: finished.address,
        auth: finished.auth,
        endpoint: { kind: "imap", ...OAUTH_ENDPOINTS[finished.provider] },
      },
    };
  }
  if (finished.provider === "google") {
    return {
      provider: "gmail",
      credentials: {
        address: finished.address,
        auth: finished.auth,
        endpoint: { kind: "gmail", pubsubTopic: finished.pubsubTopic },
      },
    };
  }
  return {
    provider: "graph",
    credentials: { address: finished.address, auth: finished.auth, endpoint: { kind: "none" } },
  };
}

export function oauthRoutes(options: OAuthRoutesOptions): Hono<AppEnv> {
  const { flow, accounts } = options;
  const apps = options.apps ?? createMemoryOAuthAppStore();
  const statusWait = options.statusWaitMs ?? 20_000;
  const outcomes = new Map<string, Outcome>();
  const waiters = new Map<string, Set<() => void>>();

  function settle(state: string, outcome: Outcome): void {
    outcomes.set(state, outcome);
    for (const w of waiters.get(state) ?? []) w();
    waiters.delete(state);
  }

  async function complete(state: string, code: string): Promise<AccountView> {
    const finished = await flow.finish(state, code);
    const { provider, credentials } = credentialsOf(finished);
    return accounts.add({ provider, credentials });
  }

  const app = new Hono<AppEnv>();

  app.get("/oauth/:provider/validate", async (c) => {
    const provider = providerOf(c.req.param("provider"));
    if (!provider) return c.json({ error: "unknown_provider" }, 404);
    const clientId = c.req.query("clientId") ?? "";
    const deps = options.fetch ? { fetch: options.fetch } : {};
    const result =
      provider === "google"
        ? await validateGoogleClient(
            { clientId, clientSecret: c.req.query("clientSecret") ?? null },
            deps,
          )
        : await validateMicrosoftClient({ clientId, tenant: c.req.query("tenant") ?? null }, deps);
    return c.json(result);
  });

  app.post("/oauth/:provider/start", async (c) => {
    const provider = providerOf(c.req.param("provider"));
    if (!provider) return c.json({ error: "unknown_provider" }, 404);
    const body = await parseBody(c, startBody);
    if (!body.ok) return body.response;
    const input = body.data;
    let client: OAuthClient;
    let pubsubTopic = input.pubsubTopic ?? null;
    if (input.clientId?.trim()) {
      client = {
        id: input.clientId.trim(),
        ...(input.clientSecret?.trim() ? { secret: input.clientSecret.trim() } : {}),
        ...(input.tenant?.trim() ? { tenant: input.tenant.trim() } : {}),
      };
    } else {
      const saved = await apps.load(provider);
      if (!saved) {
        return c.json({ error: "no_app", message: `no ${provider} sign-in app is saved` }, 400);
      }
      client = saved.client;
      if (input.pubsubTopic === undefined) pubsubTopic = saved.pubsubTopic;
    }
    const listener = options.loopback ? await options.loopback.open(provider) : null;
    const redirectUri = listener?.redirectUri ?? input.redirectUri;
    if (!redirectUri) {
      return c.json(
        { error: "no_redirect", message: "no loopback listener and no redirectUri" },
        400,
      );
    }
    const started = await flow.start({
      provider,
      client,
      path: input.path,
      redirectUri,
      pubsubTopic,
    } satisfies StartInput);
    outcomes.set(started.state, { status: "pending" });
    if (listener) {
      void listener.callback
        .then(async (query) => {
          if (query.error) {
            settle(started.state, {
              status: "error",
              message: query.error_description ?? query.error,
            });
            return;
          }
          if (!query.code) {
            settle(started.state, { status: "error", message: "redirect carried no code" });
            return;
          }
          if (query.state && query.state !== started.state) {
            settle(started.state, { status: "error", message: "state mismatch" });
            return;
          }
          try {
            settle(started.state, {
              status: "done",
              account: await complete(started.state, query.code),
            });
          } catch (error) {
            settle(started.state, {
              status: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        })
        .catch((error: unknown) => {
          settle(started.state, {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => listener.close());
    }
    return c.json({ state: started.state, url: started.url, redirectUri });
  });

  app.get("/oauth/:provider/app", async (c) => {
    const provider = providerOf(c.req.param("provider"));
    if (!provider) return c.json({ error: "unknown_provider" }, 404);
    return c.json({ app: await apps.get(provider) });
  });

  app.put("/oauth/:provider/app", async (c) => {
    const provider = providerOf(c.req.param("provider"));
    if (!provider) return c.json({ error: "unknown_provider" }, 404);
    const body = await parseBody(c, appBody);
    if (!body.ok) return body.response;
    const input = body.data;
    const deps = options.fetch ? { fetch: options.fetch } : {};
    const clientId = input.clientId.trim();
    const result =
      provider === "google"
        ? await validateGoogleClient({ clientId, clientSecret: input.clientSecret ?? null }, deps)
        : await validateMicrosoftClient({ clientId, tenant: input.tenant ?? null }, deps);
    if (!result.ok) return c.json({ result, app: null });
    const saved = await apps.put(provider, {
      clientId,
      clientSecret: provider === "google" ? (input.clientSecret ?? null) : null,
      tenant: provider === "microsoft" ? (input.tenant ?? null) : null,
      accountType: provider === "microsoft" ? (input.accountType ?? null) : null,
      projectId: input.projectId ?? null,
      pubsubTopic: provider === "google" ? (input.pubsubTopic ?? null) : null,
    });
    return c.json({ result, app: saved });
  });

  app.patch("/oauth/:provider/app", async (c) => {
    const provider = providerOf(c.req.param("provider"));
    if (!provider) return c.json({ error: "unknown_provider" }, 404);
    const body = await parseBody(c, appPatchBody);
    if (!body.ok) return body.response;
    const saved = await apps.update(provider, body.data);
    return saved ? c.json({ app: saved }) : c.json({ error: "not_found" }, 404);
  });

  app.delete("/oauth/:provider/app", async (c) => {
    const provider = providerOf(c.req.param("provider"));
    if (!provider) return c.json({ error: "unknown_provider" }, 404);
    return (await apps.remove(provider)) ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });

  app.post("/oauth/:provider/finish", async (c) => {
    if (!providerOf(c.req.param("provider"))) return c.json({ error: "unknown_provider" }, 404);
    const body = await parseBody(c, finishBody);
    if (!body.ok) return body.response;
    try {
      const account = await complete(body.data.state, body.data.code);
      settle(body.data.state, { status: "done", account });
      return c.json({ account });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      settle(body.data.state, { status: "error", message });
      const code = (error as { code?: string }).code;
      return c.json(
        { error: code === "auth" ? "auth" : "failed", message },
        code === "auth" ? 401 : 502,
      );
    }
  });

  app.get("/oauth/:provider/status", async (c) => {
    if (!providerOf(c.req.param("provider"))) return c.json({ error: "unknown_provider" }, 404);
    const state = c.req.query("state") ?? "";
    const current = outcomes.get(state);
    if (!current) return c.json({ error: "unknown_state" }, 404);
    if (current.status !== "pending") return c.json(current);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, statusWait);
      const set = waiters.get(state) ?? new Set();
      set.add(() => {
        clearTimeout(timer);
        resolve();
      });
      waiters.set(state, set);
    });
    return c.json(outcomes.get(state) ?? { status: "pending" });
  });

  return app;
}
