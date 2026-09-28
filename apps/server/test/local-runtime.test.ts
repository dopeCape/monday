// Background work on a Device's Local runtime (runtime/local.ts; CONTEXT.md,
// Local runtime and Placement) and what happens with no language model at
// all: the bridge the Sidecar holds for the client, the Hosted runtime taking
// a connected Local runtime before any key, the auto judge picking TypeSafe,
// then the language model the user actually has, then nothing, a route Job
// that waits instead of failing and sorts once a coding agent connects, a
// Workflow agentic Step answered by the Local runtime with the tools still
// run on the Server, a Step placed on this computer waiting for the app, and
// the words the user reads when nothing can run.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type Account,
  defaultSettings,
  type LocalAnswer,
  type LocalCall,
  type Settings,
  type Thread,
} from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys } from "../src/crypto/keys.ts";
import {
  createIntelligence,
  type Intelligence,
  judgeStateFor,
  ROUTE_STEP,
  WORKFLOW_STEP_STEP,
} from "../src/intelligence/index.ts";
import {
  createFakeChat,
  createFakeConverse,
  createMemoryMeter,
  fakeKeys,
} from "../src/intelligence/runtime/fake/index.ts";
import { createHostedRuntime, NoProviderKeyError } from "../src/intelligence/runtime/index.ts";
import {
  conversePrompt,
  converseSystem,
  createLocalBridge,
  type LocalBridge,
  type LocalLanguageModel,
  LocalRuntimeTimeoutError,
  parseConverseReply,
} from "../src/intelligence/runtime/local.ts";
import { createJobs, type Jobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { createCredentialStore } from "../src/providers/credentials.ts";
import {
  createFakeProvider,
  fakeCredentials,
  generateFixture,
} from "../src/providers/fake/index.ts";
import { createProviderRegistry } from "../src/providers/index.ts";
import { createSyncEngine, defaultSyncSettings, type SyncEngine } from "../src/providers/sync.ts";
import { createFakeIntegrations, createFakeMcpClients } from "../src/workflows/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const SIDECAR_TOKEN = "per-launch-token";
const fixture = generateFixture();
const NOW = new Date(fixture.recordedAt);

/** A Device asking for work in a loop, answering each prompt with `answer`, like the app's worker. */
function fakeDevice(bridge: LocalBridge, answer: (call: LocalCall) => LocalAnswer) {
  let on = true;
  const calls: LocalCall[] = [];
  const loop = (async () => {
    while (on) {
      const call = await bridge.next({ cli: "claude-code", model: null }, 20);
      if (!call) continue;
      calls.push(call);
      bridge.answer(call.id, answer(call));
    }
  })();
  return {
    calls,
    async stop() {
      on = false;
      await loop;
    },
  };
}

const settingsWith =
  (patch: Partial<Settings> = {}) =>
  async () => ({
    ...defaultSettings(),
    ...patch,
  });

describe("the Local runtime bridge", () => {
  test("a prompt goes to the Device that asks and its text comes back; nobody asking is not connected; an unanswered prompt times out", async () => {
    let clock = 1_000;
    const bridge = createLocalBridge({ now: () => clock, presenceMs: 60_000, timeoutMs: 50 });
    expect(await bridge.connected()).toBeNull();
    // A Device waiting in next() is connected, and takes the prompt the moment it is made.
    const asking = bridge.next({ cli: "claude-code", model: "sonnet" }, 5_000);
    expect(await bridge.connected()).toEqual({ cli: "claude-code", model: "sonnet" });
    const answered = bridge.complete({
      task: "classify",
      workspaceId: "ws",
      system: "sys",
      prompt: "which group?",
    });
    const call = await asking;
    expect(call).toMatchObject({ task: "classify", system: "sys", prompt: "which group?" });
    expect(bridge.answer(call?.id ?? "", { text: '{"G1": 0.9}', model: "claude-sonnet-5" })).toBe(
      true,
    );
    expect(await answered).toEqual({
      text: '{"G1": 0.9}',
      model: "claude-sonnet-5",
      cli: "claude-code",
    });
    // An answer to a call that is gone is refused.
    expect(bridge.answer(call?.id ?? "", { text: "again" })).toBe(false);
    // Asked a moment ago counts within the presence window; past it, not.
    expect(await bridge.connected()).not.toBeNull();
    clock += 61_000;
    expect(await bridge.connected()).toBeNull();
    // Nobody takes it: the call times out with a typed error.
    await expect(
      bridge.complete({ task: "classify", workspaceId: "ws", system: "", prompt: "" }),
    ).rejects.toBeInstanceOf(LocalRuntimeTimeoutError);
    // A prompt made while no one asks waits for the next ask; a failed CLI rejects it.
    const later = bridge.complete({ task: "route", workspaceId: "ws", system: "", prompt: "p" });
    const next = await bridge.next({ cli: "codex" }, 10);
    bridge.answer(next?.id ?? "", { error: "Codex is not logged in" });
    await expect(later).rejects.toThrow("Codex is not logged in");
  });
});

describe("the Hosted runtime with a Local runtime beside it", () => {
  const chat = createFakeChat("from the provider");
  const localCalls: string[] = [];
  const local = (cli: "claude-code" | null): LocalLanguageModel => ({
    takes: async (task) => (cli && task !== "composer" ? cli : null),
    complete: async (call) => {
      localCalls.push(`${call.task}: ${call.prompt}`);
      return { text: "from Claude Code", model: null, cli: "claude-code" };
    },
  });

  test("a connected Local runtime takes the Task before any key; a Hosted Session's own call never moves; the Meter counts only the provider", async () => {
    const meter = createMemoryMeter();
    const runtime = createHostedRuntime({
      chat: chat.chat,
      keys: fakeKeys({ anthropic: "sk-ant" }),
      settings: settingsWith(),
      meter,
      local: local("claude-code"),
    });
    const res = await runtime.run("classify", { system: "s", prompt: "p1" }, { workspaceId: "ws" });
    expect(res).toMatchObject({
      output: "from Claude Code",
      provider: "local",
      model: "Claude Code",
      costMicros: 0,
      meter: null,
    });
    expect(localCalls).toEqual(["classify: p1"]);
    // A call that names its provider (a Hosted Session the user chose) stays Hosted.
    const hosted = await runtime.run(
      "classify",
      { system: "s", prompt: "p2" },
      { workspaceId: "ws", provider: "anthropic" },
    );
    expect(hosted).toMatchObject({ output: "from the provider", provider: "anthropic" });
    // The composer is not in ai.local.background.tasks: it never moves.
    expect(
      (await runtime.run("composer", { system: "s", prompt: "p3" }, { workspaceId: "ws" }))
        .provider,
    ).toBe("anthropic");
    expect(meter.rows.map((e) => e.provider)).toEqual(["anthropic", "anthropic"]);
  });

  test("with no key and no Local runtime the error names the real fixes, never 'no openrouter key'", async () => {
    const runtime = createHostedRuntime({
      chat: chat.chat,
      keys: fakeKeys({}),
      settings: settingsWith({ "ai.hosted.provider": "openrouter" }),
      meter: createMemoryMeter(),
      local: local(null),
    });
    const error = await runtime
      .run("classify", { system: "s", prompt: "p" }, { workspaceId: "ws" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoProviderKeyError);
    const message = (error as Error).message;
    expect(message).not.toContain("is available to this runtime");
    expect(message).toBe(
      "No AI model can do this yet. Add your OpenRouter key under AI and agent, or open monday with a coding agent (Claude Code, Codex or OpenCode) connected. For sorting alone, a TypeSafe key is enough.",
    );
    // The words are a Setting the user can reword.
    const reworded = createHostedRuntime({
      chat: chat.chat,
      keys: fakeKeys({}),
      settings: settingsWith({ "strings.ai.no_language_model": "Need {provider} or an agent." }),
      meter: createMemoryMeter(),
    });
    await expect(
      reworded.run("brief", { system: "s", prompt: "p" }, { workspaceId: "ws" }),
    ).rejects.toThrow("Need Anthropic or an agent.");
  });

  test("an agent step through the Local runtime: monday's tools described in the prompt, tool calls read back as JSON", async () => {
    const seen: string[] = [];
    const runtime = createHostedRuntime({
      chat: chat.chat,
      keys: fakeKeys({}),
      settings: settingsWith(),
      meter: createMemoryMeter(),
      local: {
        takes: async () => "claude-code",
        complete: async (call) => {
          seen.push(call.system, call.prompt);
          return {
            text: 'I will read it.\n```json\n{"tool_calls":[{"name":"read_thread","args":{"thread_id":"t1"}}]}\n```',
            model: "claude-sonnet-5",
            cli: "claude-code",
          };
        },
      },
    });
    const step = await runtime.converse(
      "agentic-step",
      {
        system: "Run the step.",
        messages: [{ role: "user", content: "Read t1." }],
        tools: [{ name: "read_thread", description: "Reads a Thread", inputSchema: {} }],
      },
      { workspaceId: "ws" },
    );
    expect(step.toolCalls).toHaveLength(1);
    expect(step.toolCalls[0]).toMatchObject({ name: "read_thread", args: { thread_id: "t1" } });
    expect(step).toMatchObject({ provider: "local", model: "claude-sonnet-5", meter: null });
    expect(seen[0]).toContain('"name":"read_thread"');
    expect(seen[1]).toContain("User: Read t1.");
    // Plain text, or {"text": ...}, ends the step.
    expect(parseConverseReply("All done.")).toEqual({ text: "All done.", toolCalls: [] });
    expect(parseConverseReply('{"text":"Done"}')).toEqual({ text: "Done", toolCalls: [] });
    expect(parseConverseReply('Reported: {"name":"Elin","role":"Rust"}')).toEqual({
      text: 'Reported: {"name":"Elin","role":"Rust"}',
      toolCalls: [],
    });
    expect(converseSystem("s", [])).toBe("s");
    expect(
      conversePrompt([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "search", args: { q: "x" } }],
        },
        { role: "tool", toolCallId: "c1", name: "search", content: "3 threads" },
      ]),
    ).toContain('Assistant called search {"q":"x"} (id c1)\nResult of search (id c1): 3 threads');
  });
});

describe("the auto judge", () => {
  const settings = defaultSettings();
  test("TypeSafe when its key is on the Server; else a connected Local runtime; else the provider's key; else none, never a Hosted provider with no key", () => {
    expect(judgeStateFor(settings, ["typesafe"], true, "claude-code")).toEqual({
      provider: "typesafe",
      model: "jev-1.13.0",
    });
    expect(judgeStateFor(settings, [], true, "claude-code")).toEqual({
      provider: "llm",
      model: "Claude Code",
      runtime: "local",
    });
    expect(judgeStateFor(settings, ["anthropic"], true, null)).toEqual({
      provider: "llm",
      model: "claude-haiku-4-5",
      runtime: "hosted",
    });
    // The user's case: Settings name OpenRouter, nobody holds its key, nothing is connected.
    const openrouter = { ...settings, "ai.hosted.provider": "openrouter" as const };
    expect(judgeStateFor(openrouter, ["anthropic"], true, null)).toEqual({
      provider: "none",
      model: "",
    });
    expect(judgeStateFor(openrouter, [], true, null)).toEqual({ provider: "none", model: "" });
    // Pinned to the language model: the same "the one the user has" rule.
    const llm = { ...settings, "ai.judge.provider": "llm" as const };
    expect(judgeStateFor(llm, ["typesafe"], true, null).provider).toBe("none");
    expect(judgeStateFor(llm, ["typesafe"], true, "codex")).toMatchObject({ model: "Codex" });
  });
});

const account: Account = {
  id: "acct-local",
  provider: "imap",
  address: fixture.address,
  displayName: fixture.owner.name,
  capabilities: {
    push: true,
    labels: false,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
  },
};

describe("background work over Postgres with ai.mode local", () => {
  let db: TestDatabase;
  let keys: Keys;
  let store: Mailstore;
  let engine: SyncEngine;
  let intelligence: Intelligence;
  let bridge: LocalBridge;
  let app: Hono<AppEnv>;
  let clock = NOW;
  let jobs: Jobs;
  let workspaceId = "";
  const chat = createFakeChat("a provider must never be called here");
  const converse = createFakeConverse();

  const threadBySubject = async (subject: string): Promise<Thread> => {
    const page = await store.listThreads(workspaceId, { limit: 500, includeArchived: true });
    for (const t of page.threads) {
      if ((await store.readThreadSubject(t.id)).replace(/^(re|fwd?):\s*/i, "") === subject)
        return t;
    }
    throw new Error(`no thread ${subject}`);
  };
  const claim = async (cls: string) => {
    for (let i = 0; i < 200; i++) {
      const job = await jobs.claim("sidecar", ["needs-process"], 30_000);
      if (!job) return null;
      if (job.class === cls) return job;
      await jobs.requeue(job.id, "sidecar", 30 * 86_400_000);
    }
    return null;
  };

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    const credentials = createCredentialStore(db.handle.db, store);
    workspaceId = (await store.createWorkspace(account)).id;
    await credentials.store(workspaceId, account.id, fakeCredentials());
    jobs = createJobs(db.handle.db, { now: () => clock });
    engine = createSyncEngine({
      db: db.handle.db,
      mailstore: store,
      providers: createProviderRegistry({ overrides: { imap: createFakeProvider(fixture) } }),
      credentials,
      settings: async () => ({ ...defaultSyncSettings(), batchSize: 25 }),
      now: () => NOW,
      watchDebounceMs: 50,
    });
    bridge = createLocalBridge({ presenceMs: 200, timeoutMs: 5_000 });
    intelligence = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: chat.chat,
      converse: converse.converse,
      integrations: createFakeIntegrations(),
      mcp: createFakeMcpClients(),
      localBridge: bridge,
      now: () => NOW,
    });
    intelligence.registerSteps(jobs);
    app = createApp({
      db: db.handle.db,
      auth: createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN }),
      mode: "sidecar",
      keys,
      mailstore: store,
      jobs,
      sync: engine,
      intelligence,
      remoteAddress: () => "127.0.0.1",
    });
    let report = await engine.syncAccount(account.id);
    for (let i = 0; i < 60 && report.more; i++) report = await engine.syncAccount(account.id);
  }, 120_000);

  afterAll(async () => {
    await engine.close();
    await db.drop();
  });

  test("a route Job with nothing to sort with waits instead of failing, and sorts through the coding agent once it connects", async () => {
    const finance = await intelligence.routing.createGroup(workspaceId, {
      name: "Finance",
      sentence: "Money in and out: renewals, invoices, receipts.",
      predicate: {},
      threshold: null,
      briefPolicy: null,
    });
    const renewal = await threadBySubject("Renewal for the domain");
    const jobId = await intelligence.routing.enqueue(workspaceId, renewal.id, {
      id: `${ROUTE_STEP}:${renewal.id}`,
    });
    // No TypeSafe key, no provider key, no coding agent: the judge state says so.
    expect(await intelligence.judgeState()).toEqual({ provider: "none", model: "" });
    // Three turns of the queue: each one sleeps the Setting's wait, none spends an attempt.
    for (let turn = 0; turn < 3; turn++) {
      const job = await claim(ROUTE_STEP);
      expect(job?.id).toBe(jobId);
      expect(await jobs.run(job as NonNullable<typeof job>, 30_000)).toEqual({ sleepMs: 300_000 });
      const row = await jobs.get(jobId);
      expect(row).toMatchObject({ status: "queued", attempts: 0 });
      expect(row?.runAt.getTime()).toBe(clock.getTime() + 300_000);
      clock = new Date(clock.getTime() + 301_000);
    }
    expect((await threadBySubject("Renewal for the domain")).group).toBeNull();
    expect(chat.calls).toHaveLength(0);

    // The app opens with Claude Code: routing's language model is the Local runtime now.
    const device = fakeDevice(bridge, (call) => ({
      text: call.prompt.includes("G1. Finance") ? '{"G1": 0.95}' : "{}",
    }));
    try {
      await new Promise((r) => setTimeout(r, 30));
      expect(await intelligence.judgeState()).toEqual({
        provider: "llm",
        model: "Claude Code",
        runtime: "local",
      });
      const job = await claim(ROUTE_STEP);
      expect(await jobs.run(job as NonNullable<typeof job>, 30_000)).toBe("done");
    } finally {
      await device.stop();
    }
    expect(device.calls.map((c) => c.task)).toEqual(["classify"]);
    expect((await threadBySubject("Renewal for the domain")).group).toBe(finance.id);
    expect(await intelligence.routing.routeOf(renewal.id)).toMatchObject({
      groupId: finance.id,
      by: "model",
    });
    // Nothing reached a provider, and the Meter counts no Local runtime work.
    expect(chat.calls).toHaveLength(0);
    expect(
      (await intelligence.meter.month(workspaceId, NOW.toISOString().slice(0, 7))).lines,
    ).toEqual([]);
  });

  test("a Workflow agentic Step runs its model steps on the coding agent, with monday's tools run on the Server", async () => {
    const renewal = await threadBySubject("Renewal for the domain");
    const created = await intelligence.workflows.create(workspaceId, {
      name: "Summarize renewals",
      sentence: "Read renewals and say what they cost.",
      kind: "hybrid",
      trigger: { kind: "manual" },
      steps: [
        {
          id: "read",
          kind: "agentic",
          name: "Read",
          prompt: "Read the thread and say what it costs.",
          tools: ["read_thread"],
          budget: { calls: 3 },
          outputs: [],
        },
      ],
      placement: "server",
      failurePolicy: "stop",
      standingApprovals: [],
    });
    await intelligence.workflows.enable(created.id, true);
    const device = fakeDevice(bridge, (call) =>
      call.prompt.includes("Result of read_thread")
        ? { text: "The domain renewal costs 12 EUR." }
        : {
            text: JSON.stringify({
              tool_calls: [{ name: "read_thread", args: { thread_id: renewal.id } }],
            }),
          },
    );
    let runId = "";
    try {
      await new Promise((r) => setTimeout(r, 30));
      runId = (await intelligence.workflows.start(created.id, renewal.id)).id;
      const job = await claim(WORKFLOW_STEP_STEP);
      await jobs.run(job as NonNullable<typeof job>, 30_000);
    } finally {
      await device.stop();
    }
    const run = await intelligence.workflows.run(runId);
    expect(run?.status).toBe("done");
    expect(run?.steps[0]).toMatchObject({
      status: "done",
      detail: "The domain renewal costs 12 EUR.",
    });
    // Two model steps, both on the coding agent; the tool itself ran on the Server.
    expect(device.calls.map((c) => c.task)).toEqual(["agentic-step", "agentic-step"]);
    expect(device.calls[0]?.system).toContain('"name":"read_thread"');
    const activity = await intelligence.workflows.activityOf(runId);
    expect(activity.map((a) => a.tool)).toContain("read_thread");
    expect(converse.calls).toHaveLength(0);
  });

  test("a Step placed on this computer waits for the app with a line saying so; with no Local runtime and no key a Server Step fails at once with the words that name the fix", async () => {
    const make = async (name: string, placement: "local" | "server") => {
      const w = await intelligence.workflows.create(workspaceId, {
        name,
        sentence: name,
        kind: "hybrid",
        trigger: { kind: "manual" },
        steps: [
          {
            id: "think",
            kind: "agentic",
            name: "Think",
            prompt: "Say hello.",
            budget: {},
            tools: [],
            outputs: [],
          },
        ],
        placement,
        failurePolicy: "stop",
        standingApprovals: [],
      });
      await intelligence.workflows.enable(w.id, true);
      return w;
    };
    // Past the presence window: nothing is connected.
    await new Promise((r) => setTimeout(r, 250));
    const local = await make("On this computer", "local");
    const waiting = await intelligence.workflows.start(local.id);
    const job = await claim(WORKFLOW_STEP_STEP);
    expect(await jobs.run(job as NonNullable<typeof job>, 30_000)).toEqual({ sleepMs: 60_000 });
    expect(await jobs.get(job?.id ?? "")).toMatchObject({ status: "queued", attempts: 0 });
    expect(await intelligence.workflows.run(waiting.id)).toMatchObject({
      status: "queued",
      error: "Waiting for monday to be open with its coding agent connected.",
    });
    // The agent connects: the Step runs and the waiting line goes away.
    const device = fakeDevice(bridge, () => ({ text: "Hello." }));
    try {
      await new Promise((r) => setTimeout(r, 30));
      clock = new Date(clock.getTime() + 61_000);
      const again = await claim(WORKFLOW_STEP_STEP);
      await jobs.run(again as NonNullable<typeof again>, 30_000);
    } finally {
      await device.stop();
    }
    expect(await intelligence.workflows.run(waiting.id)).toMatchObject({
      status: "done",
      error: null,
    });

    await new Promise((r) => setTimeout(r, 250));
    const server = await make("On the server", "server");
    const failing = await intelligence.workflows.start(server.id);
    const step = await claim(WORKFLOW_STEP_STEP);
    await jobs.run(step as NonNullable<typeof step>, 30_000);
    const failed = await intelligence.workflows.run(failing.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.steps[0]?.detail).toContain("Add your Anthropic key under AI and agent");
    expect(failed?.steps[0]?.detail).toContain("coding agent");
    expect(failed?.steps[0]?.detail).not.toContain("is available to this runtime");
  });

  test("over HTTP: the Device asks for work, answers it, and its CLI gets a monday MCP server with no tools", async () => {
    const request = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${SIDECAR_TOKEN}`,
          ...(init.headers ?? {}),
        },
      });
    // Nothing to do: the request ends empty after its wait.
    expect((await request("/local-runtime/next?cli=claude-code&wait=0")).status).toBe(204);
    expect((await request("/local-runtime/next?wait=0")).status).toBe(400);
    const pending = bridge.complete({
      task: "classify",
      workspaceId,
      system: "sys",
      prompt: "which?",
    });
    const next = await request("/local-runtime/next?cli=claude-code&wait=1");
    expect(next.status).toBe(200);
    const { call } = (await next.json()) as { call: LocalCall };
    expect(call).toMatchObject({ task: "classify", prompt: "which?" });
    const answered = await request(`/local-runtime/calls/${call.id}`, {
      method: "POST",
      body: JSON.stringify({ text: '{"G1": 0.4}' }),
    });
    expect(answered.status).toBe(204);
    expect((await pending).text).toBe('{"G1": 0.4}');
    expect(
      (
        await request(`/local-runtime/calls/${call.id}`, {
          method: "POST",
          body: JSON.stringify({ text: "late" }),
        })
      ).status,
    ).toBe(404);

    const transport = new StreamableHTTPClientTransport(
      new URL("http://127.0.0.1:1/mcp/local?tools=none"),
      {
        requestInit: {
          headers: { authorization: `Bearer ${SIDECAR_TOKEN}`, "x-monday-workspace": workspaceId },
        },
        fetch: async (input, init) =>
          app.request(input instanceof Request ? input : String(input), init),
      },
    ) as unknown as Transport;
    const client = new Client({ name: "cli", version: "0" });
    await client.connect(transport);
    expect((await client.listTools()).tools).toEqual([]);
    const refused = await client.callTool({ name: "archive_threads", arguments: {} });
    expect(refused.isError).toBe(true);
    await client.close();
  });
});
