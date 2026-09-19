// The Device's AgentClient: one client for the composer that
// sends a Hosted Session's turns to the Server and drives a Local Session's
// CLI itself, through the adapters behind the AgentSession seam. Sessions,
// approvals, Undo and the Activity log are the Server's either way; only the
// model loop moves. A Runtime switch drops the adapter so the next turn
// spawns the new CLI with the transcript handed over.

import type {
  AgentEvent,
  AgentSession,
  LocalCli,
  Runtime,
  RuntimeInfo,
  RuntimeStatus,
  SessionStartContext,
  SessionSummary,
  Settings,
  TurnContext,
} from "@monday/shared";
import type { Api } from "../platform/api.ts";
import { type AgentClient, apiAgentClient } from "./client.ts";
import {
  apiSessionLink,
  CLI_LABEL,
  createLocalSession,
  localRuntimeSettings,
  mcpEndpointOf,
  type ProcessRunner,
  type SessionLink,
} from "./runtimes/index.ts";

export interface DeviceAgentClientOptions {
  api: Api;
  runner: ProcessRunner;
  /** The Sidecar's port and token, once it runs; a Local runtime needs the loopback endpoint. */
  sidecar: () => { port: number; token: string } | null;
  settings: () => Settings;
  /** The Workspace's address, for the system prompt. */
  address: (workspaceId: string) => string;
  /** The line to the Server; the Api by default, an in-process host in tests. */
  link?: SessionLink | undefined;
  /** What detection found for a CLI, when it ran; a ruled-out CLI is refused with its reason. */
  statusOf?: ((cli: LocalCli) => RuntimeStatus | null) | undefined;
  now?: (() => Date) | undefined;
  log?: ((line: string) => void) | undefined;
}

export function deviceAgentClient(options: DeviceAgentClientOptions): AgentClient {
  const hosted = apiAgentClient(options.api);
  const link = options.link ?? apiSessionLink(options.api);
  const sessions = new Map<string, SessionSummary>();
  const local = new Map<string, AgentSession>();

  const remember = (session: SessionSummary) => {
    sessions.set(session.id, session);
    return session;
  };

  const fill = (template: string, values: Record<string, string>) =>
    template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

  /** A start that failed, in plain words: the CLI's name and what it said. */
  const startFailure = (cli: LocalCli, error: unknown): Error =>
    new Error(
      fill(options.settings()["strings.agent.start_failed"], {
        runtime: CLI_LABEL[cli],
        message: error instanceof Error ? error.message : String(error),
      }),
    );

  const sessionOf = async (id: string): Promise<SessionSummary> => {
    const known = sessions.get(id);
    if (known) return known;
    return remember((await options.api.agent.session(id)).session);
  };

  const dropLocal = async (id: string) => {
    const adapter = local.get(id);
    local.delete(id);
    await adapter?.cancel();
  };

  const adapterFor = (session: SessionSummary): AgentSession => {
    if (session.runtime.kind !== "local") throw new Error("not a local Session");
    const cli = session.runtime.cli;
    const existing = local.get(session.id);
    if (existing && existing.runtime().runtime.kind === "local") {
      const running = existing.runtime().runtime;
      if (running.kind === "local" && running.cli === cli) return existing;
    }
    const status = options.statusOf?.(cli) ?? null;
    if (status?.reason) throw new Error(status.reason);
    const sidecar = options.sidecar();
    if (!sidecar) throw new Error(options.settings()["strings.agent.sidecar_missing"]);
    const created = createLocalSession(cli, {
      runner: options.runner,
      link,
      mcp: mcpEndpointOf(sidecar),
      settings: () => localRuntimeSettings(options.settings(), cli),
      now: options.now,
      log: options.log,
    });
    local.set(session.id, created);
    return created;
  };

  const startContext = async (
    session: SessionSummary,
    context: TurnContext,
  ): Promise<SessionStartContext> => {
    const { events } = await options.api.agent.session(session.id);
    return {
      ...context,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      address: options.address(session.workspaceId),
      epoch: events.filter((e) => e.kind === "runtime").length,
      transcript: events,
      developerMode: context.developerMode ?? options.settings()["ai.developer_mode_default"],
      webFetch: options.settings()["ai.web_fetch"],
    };
  };

  return {
    async listSessions(workspaceId) {
      const list = await hosted.listSessions(workspaceId);
      for (const s of list) remember(s);
      return list;
    },
    async createSession(workspaceId, runtime) {
      return remember(await hosted.createSession(workspaceId, runtime));
    },
    async load(sessionId) {
      const loaded = await hosted.load(sessionId);
      remember(loaded.session);
      return loaded;
    },
    async switchRuntime(sessionId, runtime: Runtime) {
      const event = await hosted.switchRuntime(sessionId, runtime);
      const known = sessions.get(sessionId);
      if (known) sessions.set(sessionId, { ...known, runtime });
      await dropLocal(sessionId);
      return event;
    },
    runtimeOf(sessionId): RuntimeInfo | null {
      const adapter = local.get(sessionId);
      if (adapter) return adapter.runtime();
      const session = sessions.get(sessionId);
      if (!session) return null;
      return {
        runtime: session.runtime,
        model:
          session.runtime.kind === "hosted"
            ? session.runtime.model
            : (session.runtime.model ?? null),
      };
    },
    async turn(sessionId, text, context, onEvent) {
      const session = await sessionOf(sessionId);
      if (session.runtime.kind === "hosted") return hosted.turn(sessionId, text, context, onEvent);
      const adapter = adapterFor(session);
      try {
        await adapter.start(await startContext(session, context));
      } catch (error) {
        throw startFailure(session.runtime.cli, error);
      }
      await adapter.send(text, onEvent);
    },
    async approve(sessionId, activityId, decision, context, onEvent) {
      const session = await sessionOf(sessionId);
      if (session.runtime.kind === "hosted") {
        return hosted.approve(sessionId, activityId, decision, context, onEvent);
      }
      const adapter = local.get(sessionId);
      if (!adapter) {
        // The CLI is gone (the app restarted); the Server answers the card on its own.
        return hosted.approve(sessionId, activityId, decision, context, onEvent);
      }
      await adapter.resume(activityId, decision, onEvent);
    },
    undo: (activityId, sessionId) => hosted.undo(activityId, sessionId),
  };
}

export type { AgentEvent };
