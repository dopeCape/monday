// Background work on a Local runtime (CONTEXT.md: "a command-line agent on
// the user's machine that the client drives. Only available while the client
// is running"; ADR 0005: Local runtime steps are claimed by the Sidecar).
//
// The Sidecar never spawns a CLI: the client does. So a Task that needs a
// language model while a Device's `ai.mode` is local becomes one prompt the
// Sidecar holds in memory, and the client, which asks for work with a
// long-poll (GET /local-runtime/next), runs it through its CLI and posts the
// text back (POST /local-runtime/calls/:id). The Job that made the call keeps
// its lease meanwhile; nothing about the prompt is written to the database.
// Tools and approvals stay on the Server: the agent loop is the Server's own
// (ADR 0002, ADR 0007), and each of its model steps is one prompt here.
//
// A Device counts as connected while it has a request open or asked within
// `ai.local.background.presence_seconds`. The Cloud never has one: a client
// talks to its Sidecar whenever one runs.

import type { LocalAnnounce, LocalAnswer, LocalCall, LocalCli, Task } from "@monday/shared";
import type { AgentMessage, AgentToolCall, ConverseInput, RunInput, ToolSpec } from "./index.ts";

export const LOCAL_CLI_LABEL: Record<LocalCli, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

/** The Device's CLI did not answer in time, or went away with the prompt. */
export class LocalRuntimeTimeoutError extends Error {
  readonly status = 504;
  constructor(readonly cli: LocalCli | null) {
    super(`${cli ? LOCAL_CLI_LABEL[cli] : "The command-line agent"} did not answer in time`);
    this.name = "LocalRuntimeTimeoutError";
  }
}

/** The Device ran the prompt and its CLI failed. */
export class LocalRuntimeError extends Error {
  readonly status = 502;
  constructor(message: string) {
    super(message);
    this.name = "LocalRuntimeError";
  }
}

/** A duration in ms, fixed or read from a Setting each time. */
type Ms = number | (() => Promise<number> | number);

export interface LocalBridgeOptions {
  now?: () => number;
  /** ai.local.background.presence_seconds, in ms. */
  presenceMs: Ms;
  /** ai.local.background.timeout_seconds, in ms. */
  timeoutMs: Ms;
}

const read = async (ms: Ms): Promise<number> => (typeof ms === "number" ? ms : ms());

export interface LocalCompletion {
  text: string;
  model: string | null;
  cli: LocalCli;
}

export interface LocalBridge {
  /** The CLI of a Device that is connected now, or null. */
  connected(): Promise<LocalAnnounce | null>;
  /** Hands one prompt to the connected Device and waits for its text. */
  complete(call: Omit<LocalCall, "id">): Promise<LocalCompletion>;
  /** A Device asks for work: the next prompt, or null once `waitMs` passed with none. */
  next(announce: LocalAnnounce, waitMs: number, signal?: AbortSignal): Promise<LocalCall | null>;
  /** The Device's answer; false when the call is unknown (answered, timed out). */
  answer(id: string, answer: LocalAnswer): boolean;
}

interface Pending {
  call: LocalCall;
  taken: boolean;
  resolve: (c: LocalCompletion) => void;
  reject: (e: Error) => void;
  cli: LocalCli | null;
  timer: ReturnType<typeof setTimeout>;
}

export function createLocalBridge(options: LocalBridgeOptions): LocalBridge {
  const now = options.now ?? (() => Date.now());
  const pending = new Map<string, Pending>();
  /** Devices blocked in next(), oldest first. */
  const waiting: Array<{ announce: LocalAnnounce; give: (call: LocalCall | null) => void }> = [];
  let last: { announce: LocalAnnounce; at: number } | null = null;

  const hand = (p: Pending, announce: LocalAnnounce) => {
    p.taken = true;
    p.cli = announce.cli;
    return p.call;
  };

  const bridge: LocalBridge = {
    async connected() {
      const open = waiting[0];
      if (open) return open.announce;
      if (!last) return null;
      return now() - last.at <= (await read(options.presenceMs)) ? last.announce : null;
    },

    async complete(input) {
      const call: LocalCall = { ...input, id: crypto.randomUUID() };
      const timeout = await read(options.timeoutMs);
      return new Promise<LocalCompletion>((resolve, reject) => {
        const p: Pending = {
          call,
          taken: false,
          resolve,
          reject,
          cli: null,
          timer: setTimeout(() => {
            pending.delete(call.id);
            reject(new LocalRuntimeTimeoutError(p.cli));
          }, timeout),
        };
        pending.set(call.id, p);
        const device = waiting.shift();
        if (device) device.give(hand(p, device.announce));
      });
    },

    next(announce, waitMs, signal) {
      last = { announce, at: now() };
      for (const p of pending.values()) {
        if (!p.taken) return Promise.resolve(hand(p, announce));
      }
      return new Promise<LocalCall | null>((resolve) => {
        const entry = {
          announce,
          give: (call: LocalCall | null) => {
            clearTimeout(timer);
            last = { announce, at: now() };
            resolve(call);
          },
        };
        const drop = () => {
          const at = waiting.indexOf(entry);
          if (at >= 0) waiting.splice(at, 1);
          entry.give(null);
        };
        const timer = setTimeout(drop, Math.max(0, waitMs));
        signal?.addEventListener("abort", drop, { once: true });
        waiting.push(entry);
      });
    },

    answer(id, answer) {
      const p = pending.get(id);
      if (!p) return false;
      pending.delete(id);
      clearTimeout(p.timer);
      if ("error" in answer) p.reject(new LocalRuntimeError(answer.error));
      else
        p.resolve({ text: answer.text, model: answer.model ?? null, cli: p.cli ?? "claude-code" });
      return true;
    },
  };
  return bridge;
}

/* ------------------------------ The runtime's seam ------------------------------ */

/**
 * What the Hosted runtime asks before and instead of a provider call: whether
 * a Device's Local runtime takes this Task now, and the call itself.
 */
export interface LocalLanguageModel {
  /** The CLI that takes `task` now, or null (no Device connected, or the Task is not in the Setting). */
  takes(task: Task): Promise<LocalCli | null>;
  complete(call: Omit<LocalCall, "id">): Promise<LocalCompletion>;
}

export function localLanguageModel(
  bridge: LocalBridge,
  tasks: () => Promise<readonly Task[]>,
): LocalLanguageModel {
  return {
    async takes(task) {
      const device = await bridge.connected();
      if (!device) return null;
      return (await tasks()).includes(task) ? device.cli : null;
    },
    complete: (call) => bridge.complete(call),
  };
}

/* ------------------------------ One agent step as one prompt ------------------------------ */

/**
 * The protocol a Local runtime answers an agent step in. The CLI runs with
 * no tools of its own (monday's MCP server lists none for these calls), so
 * it asks for monday's tools by name in JSON and the Server's loop runs them
 * with their tiers and approvals, exactly as for a Hosted provider.
 */
export function converseSystem(system: string, tools: readonly ToolSpec[]): string {
  if (tools.length === 0) return system;
  const listing = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input: t.inputSchema,
  }));
  return [
    system,
    "",
    "You act only through these tools, which monday runs for you. You cannot call them yourself.",
    'To use tools, answer with one JSON object and nothing else: {"tool_calls":[{"name":"<tool>","args":{...}}]}. You will get their results in the next message.',
    'When you are done, answer with plain text, or with {"text":"<your answer>"}.',
    `Tools: ${JSON.stringify(listing)}`,
  ].join("\n");
}

/** The transcript as one prompt: each turn labelled, tool calls and results in order. */
export function conversePrompt(messages: readonly AgentMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") lines.push(`User: ${m.content}`);
    else if (m.role === "assistant") {
      if (m.content) lines.push(`Assistant: ${m.content}`);
      for (const call of m.toolCalls) {
        lines.push(`Assistant called ${call.name} ${JSON.stringify(call.args)} (id ${call.id})`);
      }
    } else {
      lines.push(
        `Result of ${m.name} (id ${m.toolCallId})${m.isError ? ", failed" : ""}: ${m.content}`,
      );
    }
  }
  lines.push("", "Answer with your next step.");
  return lines.join("\n");
}

/** The last balanced JSON object in a text, parsed, or null. */
function lastObject(text: string): Record<string, unknown> | null {
  const unfenced = text.replace(/```(?:json)?/g, "");
  for (let end = unfenced.lastIndexOf("}"); end >= 0; end = unfenced.lastIndexOf("}", end - 1)) {
    let depth = 0;
    for (let start = end; start >= 0; start--) {
      const ch = unfenced[start];
      if (ch === "}") depth += 1;
      else if (ch === "{") depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(unfenced.slice(start, end + 1)) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          // Not this span; an earlier closing brace may start a valid object.
        }
        break;
      }
    }
  }
  return null;
}

/** Reads a Local runtime's answer to one agent step: tool calls it asked for, or its text. */
export function parseConverseReply(
  reply: string,
  newId: () => string = () => crypto.randomUUID(),
): { text: string; toolCalls: AgentToolCall[] } {
  const found = lastObject(reply);
  const raw = found?.tool_calls;
  if (Array.isArray(raw) && raw.length > 0) {
    const toolCalls: AgentToolCall[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const { name, args } = item as { name?: unknown; args?: unknown };
      if (typeof name !== "string" || !name) continue;
      toolCalls.push({
        id: newId(),
        name,
        args: args && typeof args === "object" ? (args as Record<string, unknown>) : {},
      });
    }
    if (toolCalls.length > 0) {
      return { text: typeof found?.text === "string" ? found.text : "", toolCalls };
    }
  }
  if (found && typeof found.text === "string" && Object.keys(found).length === 1) {
    return { text: found.text, toolCalls: [] };
  }
  return { text: reply.trim(), toolCalls: [] };
}

/** What a run() call sends a Local runtime. */
export function runAsCall(task: Task, input: RunInput, workspaceId: string): Omit<LocalCall, "id"> {
  return { task, workspaceId, system: input.system, prompt: input.prompt };
}

/** What a converse() call sends a Local runtime. */
export function converseAsCall(
  task: Task,
  input: ConverseInput,
  workspaceId: string,
): Omit<LocalCall, "id"> {
  return {
    task,
    workspaceId,
    system: converseSystem(input.system, input.tools),
    prompt: conversePrompt(input.messages),
  };
}
