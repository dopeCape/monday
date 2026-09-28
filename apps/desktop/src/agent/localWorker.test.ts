// The app's Local runtime worker (localWorker.ts) over its seams: a scripted
// Claude Code process in the exact stream format the adapter reads, and a
// fake Sidecar that hands out prompts and records the answers.

import { describe, expect, test } from "bun:test";
import {
  defaultSettings,
  type LocalAnnounce,
  type LocalAnswer,
  type LocalCall,
  type RuntimeStatus,
  type Settings,
} from "@monday/shared";
import { answerLocalCall, backgroundMcpOf, startLocalWorker } from "./localWorker.ts";
import { fakeProcessRunner } from "./runtimes/index.ts";
import { localWorkerCli } from "./useLocalWorker.ts";

const init = JSON.stringify({
  type: "system",
  subtype: "init",
  model: "claude-sonnet-5",
  mcp_servers: [{ name: "monday", status: "connected" }],
});
const answer = (text: string) => [
  JSON.stringify({
    type: "assistant",
    message: { id: "msg_1", content: [{ type: "text", text }] },
  }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }),
];
const claudeSays = (text: string) => ({
  greeting: [init],
  replies: [() => answer(text)],
  exitCode: 0,
});

const settings = (patch: Partial<Settings> = {}): Settings => ({
  ...defaultSettings(),
  "ai.mode": "local",
  "ai.level": "automate",
  ...patch,
});
const call = (prompt: string): LocalCall => ({
  id: `call-${prompt}`,
  task: "classify",
  workspaceId: "ws-1",
  system: "You route email threads.",
  prompt,
});
const MCP = backgroundMcpOf({ port: 4242, token: "device-token" });

describe("answering one background prompt", () => {
  test("the prompt runs through Claude Code with the call's system prompt and a monday MCP server with no tools; the text comes back and the process ends", async () => {
    const runner = fakeProcessRunner({ claude: claudeSays('{"G1": 0.93}') });
    const result = await answerLocalCall(call("Subject: Renewal"), {
      runner: runner.runner,
      mcp: MCP,
      cli: "claude-code",
      settings: () => settings(),
    });
    expect(result).toEqual({ text: '{"G1": 0.93}', model: "claude-sonnet-5" });
    const spawned = runner.spawns[0];
    const args = spawned?.options.args ?? [];
    // The same argument shape the Tauri capability allows, never Developer mode.
    expect(args).toContain("--tools");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--system-prompt") + 1]).toStartWith("You route email threads.");
    expect(args[args.indexOf("--mcp-config") + 1]).toContain(
      "http://127.0.0.1:4242/mcp/local?tools=none",
    );
    expect(spawned?.process.written.join("\n")).toContain("Subject: Renewal");
    expect(spawned?.process.killed).toBe(true);
  });

  test("a CLI that fails answers with its error, not with text", async () => {
    const runner = fakeProcessRunner({
      claude: {
        greeting: [init],
        replies: [
          () => [
            JSON.stringify({
              type: "result",
              subtype: "error_during_execution",
              is_error: true,
              result: "Not logged in",
            }),
          ],
        ],
      },
    });
    expect(
      await answerLocalCall(call("x"), {
        runner: runner.runner,
        mcp: MCP,
        cli: "claude-code",
        settings: () => settings(),
      }),
    ).toEqual({ error: "Not logged in" });
    const missing = fakeProcessRunner({});
    const spawnFailed = await answerLocalCall(call("y"), {
      runner: missing.runner,
      mcp: MCP,
      cli: "claude-code",
      settings: () => settings(),
    });
    expect("error" in spawnFailed && spawnFailed.error).toContain("command not found");
  });
});

describe("the worker loop", () => {
  test("it asks the Sidecar with its CLI, answers each prompt, and stops when told", async () => {
    const queue = [call("first"), call("second")];
    const asks: Array<{ announce: LocalAnnounce; wait: number }> = [];
    const answers: Array<{ id: string; answer: LocalAnswer }> = [];
    let idle!: () => void;
    const drained = new Promise<void>((resolve) => {
      idle = resolve;
    });
    const api = {
      localRuntime: {
        next: async (announce: LocalAnnounce, wait: number, signal?: AbortSignal) => {
          asks.push({ announce, wait });
          const next = queue.shift();
          if (next) return next;
          idle();
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          return null;
        },
        answer: async (id: string, a: LocalAnswer) => {
          answers.push({ id, answer: a });
        },
      },
    };
    const runner = fakeProcessRunner({ claude: claudeSays("ok") });
    const worker = startLocalWorker({
      api,
      runner: runner.runner,
      mcp: MCP,
      cli: "claude-code",
      settings: () =>
        settings({ "ai.local.background.concurrency": 1, "ai.local.model.claude-code": "opus" }),
    });
    await drained;
    worker.stop();
    await worker.done;
    expect(answers).toEqual([
      { id: "call-first", answer: { text: "ok", model: "claude-sonnet-5" } },
      { id: "call-second", answer: { text: "ok", model: "claude-sonnet-5" } },
    ]);
    expect(asks[0]).toEqual({ announce: { cli: "claude-code", model: "opus" }, wait: 25 });
    // One process per prompt, each ended.
    expect(runner.spawns.map((s) => s.process.killed)).toEqual([true, true]);
  });

  test("the worker runs only in local mode with a ready command-line agent, never at AI level off", () => {
    const ready: RuntimeStatus = {
      cli: "claude-code",
      command: "claude",
      installed: true,
      version: "2.1",
      loggedIn: true,
      reason: null,
    };
    const statusOf = () => ready;
    expect(localWorkerCli(settings(), statusOf)).toBe("claude-code");
    expect(localWorkerCli(settings({ "ai.mode": "hosted" }), statusOf)).toBeNull();
    expect(localWorkerCli(settings({ "ai.level": "off" }), statusOf)).toBeNull();
    expect(localWorkerCli(settings(), () => ({ ...ready, reason: "Not logged in" }))).toBeNull();
    expect(localWorkerCli(settings(), () => null)).toBeNull();
    expect(
      localWorkerCli(settings({ "ai.local.cli": "codex" }), (cli) => ({ ...ready, cli })),
    ).toBe("codex");
  });
});
