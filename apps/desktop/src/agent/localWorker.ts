// Background work on this Device's Local runtime (CONTEXT.md, Local runtime;
// docs/spec/workflows.md, "Local runtime work"). While `ai.mode` is local and
// the chosen command-line agent is ready, the app asks its Sidecar for work
// (GET /local-runtime/next, a long-poll) and answers each prompt through the
// same adapter the composer uses: a fresh CLI process per prompt, no Session,
// and monday's MCP server listing no tools (`?tools=none`), so the CLI only
// writes text. Tools, tiers and approvals stay in the Server's own loop
// (ADR 0002). Asking is also what tells the Sidecar a Local runtime is
// connected; when the app closes, the Sidecar stops handing work over.

import type {
  AgentEvent,
  LocalAnnounce,
  LocalAnswer,
  LocalCall,
  LocalCli,
  SessionStartContext,
  Settings,
} from "@monday/shared";
import type { Api } from "../platform/api.ts";
import {
  createLocalSession,
  localRuntimeSettings,
  type McpEndpoint,
  type ProcessRunner,
  type SessionLink,
} from "./runtimes/index.ts";

/** The loopback MCP endpoint for background prompts: monday's server, no tools listed. */
export function backgroundMcpOf(sidecar: { port: number; token: string }): McpEndpoint {
  return { url: `http://127.0.0.1:${sidecar.port}/mcp/local?tools=none`, token: sidecar.token };
}

/** A line to the Server that keeps nothing: a background prompt is no Session. */
const silentLink: SessionLink = {
  live: () => () => {},
  append: async () => {},
  approve: async () => {
    throw new Error("a background prompt has no approvals");
  },
  switchRuntime: async () => {
    throw new Error("a background prompt has no Session");
  },
};

export interface LocalCallDeps {
  runner: ProcessRunner;
  mcp: McpEndpoint;
  cli: LocalCli;
  settings: () => Settings;
  now?: (() => Date) | undefined;
  log?: ((line: string) => void) | undefined;
}

/**
 * Runs one prompt through the CLI and returns its text, or the error it
 * ended with. Always ends the process. Bounded by
 * `ai.local.background.timeout_seconds`, the Server's own wait.
 */
export async function answerLocalCall(call: LocalCall, deps: LocalCallDeps): Promise<LocalAnswer> {
  const settings = deps.settings();
  const session = createLocalSession(deps.cli, {
    runner: deps.runner,
    link: silentLink,
    mcp: deps.mcp,
    settings: () => ({
      ...localRuntimeSettings(deps.settings(), deps.cli),
      systemPrompt: call.system,
    }),
    now: deps.now,
    log: deps.log,
  });
  const context: SessionStartContext = {
    workspaceId: call.workspaceId,
    sessionId: crypto.randomUUID(),
    address: "",
    epoch: 0,
    transcript: [],
    developerMode: false,
    webFetch: false,
  };
  const texts: string[] = [];
  let failure: string | null = null;
  const onEvent = (event: AgentEvent) => {
    if (event.kind === "text" && event.text) texts.push(event.text);
    else if (event.kind === "error") failure = event.message;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(
      () => resolve("timeout"),
      settings["ai.local.background.timeout_seconds"] * 1000,
    );
  });
  try {
    await session.start(context);
    const outcome = await Promise.race([session.send(call.prompt, onEvent), timeout]);
    if (outcome === "timeout") return { error: "The command-line agent did not answer in time." };
    if (failure) return { error: failure };
    const model = session.runtime().model;
    return { text: texts.join("\n").trim(), ...(model ? { model } : {}) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    await session.cancel().catch(() => {});
  }
}

export interface LocalWorkerOptions extends LocalCallDeps {
  /** The Sidecar's own Api: the bridge lives in the Sidecar process. */
  api: Pick<Api, "localRuntime">;
}

export interface LocalWorker {
  stop(): void;
  /** Resolves once every loop has ended, after stop(). */
  readonly done: Promise<void>;
}

/**
 * One long-poll asks for prompts and hands each to one of up to
 * `ai.local.background.concurrency` runs. Only ever one request waits on the
 * Sidecar: WebKit keeps six connections to a host, and one waiting ask per
 * run starved every other request the app makes (Workflows, Settings, search
 * waited behind them for 20 seconds). A failed ask (the Sidecar restarting)
 * waits one poll before asking again.
 */
export function startLocalWorker(options: LocalWorkerOptions): LocalWorker {
  const abort = new AbortController();
  const settings = options.settings();
  const announce: LocalAnnounce = {
    cli: options.cli,
    model: settings[`ai.local.model.${options.cli}`] || null,
  };
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      abort.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  const running = new Set<Promise<void>>();
  const run = async (call: LocalCall) => {
    const answer = await answerLocalCall(call, options);
    await options.api.localRuntime.answer(call.id, answer).catch((error: unknown) => {
      options.log?.(
        `[local work] answer ${call.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  const loop = async () => {
    while (!abort.signal.aborted) {
      // Ask only while a run is free; a full house waits for one to finish.
      const limit = Math.max(1, options.settings()["ai.local.background.concurrency"]);
      if (running.size >= limit) {
        await Promise.race(running);
        continue;
      }
      const poll = options.settings()["ai.local.background.poll_seconds"];
      let call: LocalCall | null;
      try {
        call = await options.api.localRuntime.next(announce, poll, abort.signal);
      } catch (error) {
        if (abort.signal.aborted) break;
        options.log?.(`[local work] ${error instanceof Error ? error.message : String(error)}`);
        await pause(poll * 1000);
        continue;
      }
      if (!call || abort.signal.aborted) continue;
      const done: Promise<void> = run(call).finally(() => running.delete(done));
      running.add(done);
    }
    await Promise.all(running);
  };
  const poller = loop();
  return {
    stop: () => abort.abort(),
    done: poller,
  };
}
