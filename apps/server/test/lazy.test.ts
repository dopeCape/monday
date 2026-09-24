// The heavy packages load on first use, not at boot: LangChain and its
// provider packages on the first hosted-model call, LangGraph and its Postgres
// checkpointer on the first Hosted turn, the MCP SDK on the first MCP request
// (agent-local.test.ts and external.test.ts drive those routes), imapflow on
// the first IMAP connection, nodemailer on the first send. Each first use is
// driven here through the lazy path against a fake on loopback, and a fresh
// process that imports everything the Bun entry imports is checked to hold
// none of them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { join } from "node:path";
import type { AgentEvent, SessionSummary } from "@monday/shared";
import { createCheckpointer } from "../entry/checkpointer.ts";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { createIntelligence } from "../src/intelligence/index.ts";
import { createFakeChat, createFakeConverse } from "../src/intelligence/runtime/fake/index.ts";
import {
  lazyLangChainChat,
  lazyLangChainConverse,
  loadLangChain,
} from "../src/intelligence/runtime/langchain-lazy.ts";
import { lazy } from "../src/lazy.ts";
import { createMailstore } from "../src/mailstore/index.ts";
import { createImapProvider } from "../src/providers/imap/index.ts";
import { createSmtpSender } from "../src/providers/imap/smtp.ts";
import { composeMime } from "../src/providers/mime.ts";
import { ProviderError } from "../src/providers/types.ts";
import { testDatabase } from "./harness.ts";

const HEAVY = [
  "@langchain/",
  "@modelcontextprotocol/sdk",
  "imapflow",
  "nodemailer",
  "sanitize-html",
  "postcss",
  "/node_modules/pg/",
];

describe("boot", () => {
  test("the Bun entry's imports load none of the heavy packages", async () => {
    // Every module entry/bun.ts imports statically, in a fresh process.
    const modules = [
      "src/app.ts",
      "src/capabilities.ts",
      "src/changes/bus.ts",
      "src/db/client.ts",
      "src/db/migrate.ts",
      "src/drafts/index.ts",
      "src/external/index.ts",
      "src/heartbeat.ts",
      "src/kicker/process.ts",
      "src/providers/autoconfig.ts",
      "src/providers/oauth/flow.ts",
      "src/routes/upgrade.ts",
      "src/settings/read.ts",
      "src/upgrade/index.ts",
      "entry/attach.ts",
      "entry/changes-ws.ts",
      "entry/checkpointer.ts",
      "entry/embedded-postgres.ts",
      "entry/oauth-loopback.ts",
      "entry/pg-dump.ts",
      "entry/resources.ts",
      "entry/services.ts",
      "entry/cloud.ts",
    ];
    const root = join(import.meta.dir, "..");
    const script = [
      ...modules.map((m) => `await import(${JSON.stringify(join(root, m))});`),
      "console.log(JSON.stringify([...Loader.registry.keys()]));",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", script], { cwd: root, stdout: "pipe" });
    const out = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const loaded = JSON.parse(out) as string[];
    expect(loaded.some((k) => k.endsWith("src/app.ts"))).toBe(true);
    expect(loaded.filter((k) => HEAVY.some((h) => k.includes(h)))).toEqual([]);
  });
});

describe("lazy", () => {
  test("loads once, shares the load, and tries again after a failure", async () => {
    let calls = 0;
    const load = lazy(async () => {
      calls++;
      if (calls === 1) throw new Error("first load fails");
      return { n: calls };
    });
    await expect(load()).rejects.toThrow("first load fails");
    const [a, b] = await Promise.all([load(), load()]);
    expect(a).toBe(b);
    expect(await load()).toBe(a);
    expect(calls).toBe(2);
  });
});

/* ------------------------------ A hosted model on loopback ------------------------------ */

/** An OpenAI-compatible chat completions endpoint: a JSON answer, or the same answer streamed. */
function fakeOpenAi(answer: string) {
  const requests: Array<{ model: string; stream: boolean }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model: string; stream?: boolean };
      requests.push({ model: body.model, stream: body.stream === true });
      const base = { id: "chatcmpl-1", created: 0, model: body.model };
      const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
      if (!body.stream) {
        return Response.json({
          ...base,
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" },
          ],
          usage,
        });
      }
      const half = Math.ceil(answer.length / 2);
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const sse =
        chunk({ role: "assistant", content: answer.slice(0, half) }, null) +
        chunk({ content: answer.slice(half) }, null) +
        chunk({}, "stop") +
        `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [], usage })}\n\n` +
        "data: [DONE]\n\n";
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

describe("a hosted-model call through the lazy LangChain path", () => {
  const model = fakeOpenAi("Hello from the fake.");
  afterAll(() => model.stop());
  const base = {
    provider: "openrouter" as const,
    model: "fake/model",
    effort: "low" as const,
    maxOutputTokens: 256,
    key: "not-a-real-key",
    baseUrl: model.url,
    system: "You are terse.",
  };

  test("the first chat call loads LangChain and answers; later calls reuse it", async () => {
    const chat = lazyLangChainChat();
    const first = await chat({ ...base, prompt: "Say hello." });
    expect(first.text).toBe("Hello from the fake.");
    expect(first.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    const loaded = await loadLangChain();
    expect(await loadLangChain()).toBe(loaded);
    expect((await chat({ ...base, prompt: "Again." })).text).toBe("Hello from the fake.");
    expect(model.requests.filter((r) => !r.stream)).toHaveLength(2);
  });

  test("the agent loop's seam streams through the same lazy load", async () => {
    const converse = lazyLangChainConverse();
    const deltas: string[] = [];
    const answer = await converse({
      ...base,
      messages: [{ role: "user", content: "Say hello." }],
      tools: [
        {
          name: "search_threads",
          description: "Search",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      onText: (d) => deltas.push(d),
    });
    expect(answer.text).toBe("Hello from the fake.");
    expect(answer.toolCalls).toEqual([]);
    expect(deltas.join("")).toBe("Hello from the fake.");
    expect(model.requests.some((r) => r.stream)).toBe(true);
  });
});

/* ------------------------------ The checkpointer loader ------------------------------ */

describe("an Agent turn through the entry's lazy checkpointer", () => {
  const SIDECAR_TOKEN = "per-launch-token";
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let checkpointer: ReturnType<typeof createCheckpointer>;

  beforeAll(async () => {
    db = await testDatabase();
  });
  afterAll(async () => {
    await checkpointer?.end();
    await db.drop();
  });

  test("the first turn loads and sets up the checkpointer; the transcript lands in Postgres", async () => {
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    const store = createMailstore(db.handle.db, keys);
    checkpointer = createCheckpointer(db.url, db.handle.db, store);
    const converse = createFakeConverse("Nothing to do.");
    let loads = 0;
    const intelligence = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: createFakeChat("").chat,
      converse: converse.converse,
      checkpointer: () => {
        loads++;
        return checkpointer.load();
      },
    });
    const app = createApp({
      db: db.handle.db,
      auth: createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN }),
      mode: "sidecar",
      keys,
      mailstore: store,
      intelligence,
      remoteAddress: () => "127.0.0.1",
    });
    const send = (path: string, body: unknown, method = "POST") =>
      app.request(path, {
        method,
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", authorization: `Bearer ${SIDECAR_TOKEN}` },
      });
    const workspaceId = (
      await store.createWorkspace({
        id: "acct-lazy",
        provider: "imap",
        address: "me@example.test",
        displayName: "Me",
        capabilities: {
          push: false,
          labels: false,
          snooze: false,
          mute: false,
          calendar: false,
          meetingLink: null,
        },
      })
    ).id;
    expect(
      (await send("/keys/anthropic", { workspace: workspaceId, key: "sk" }, "PUT")).status,
    ).toBe(200);

    // Nothing has touched the checkpointer: its tables do not exist yet.
    const tables = async () =>
      (
        await db.handle.sql<{ n: number }[]>`
          select count(*)::int as n from information_schema.tables where table_schema = 'langgraph'
        `
      )[0]?.n;
    expect(await tables()).toBe(0);
    expect(loads).toBe(0);

    const session = (await (
      await send("/sessions", { workspace: workspaceId })
    ).json()) as SessionSummary;
    for (const text of ["hello", "and again"]) {
      const turn = await send(`/sessions/${session.id}/turns`, { text });
      expect(turn.status).toBe(200);
      const body = await turn.text();
      const done = body
        .split("\n\n")
        .map((b) => b.split("\n").find((l) => l.startsWith("data:")))
        .filter((l): l is string => Boolean(l))
        .map((l) => JSON.parse(l.slice(5).trim()) as AgentEvent)
        .at(-1);
      expect(done?.kind).toBe("done");
      converse.script("Still nothing.");
    }

    expect(loads).toBe(1);
    expect(await tables()).toBe(4);
    const rows = await db.handle.sql<{ n: number }[]>`
      select count(*)::int as n from langgraph.checkpoints where thread_id = ${session.id}
    `;
    expect(rows[0]?.n).toBeGreaterThan(0);
    expect(await checkpointer.load()).toBe(await checkpointer.load());
  });
});

/* ------------------------------ IMAP and SMTP on loopback ------------------------------ */

/** A line-oriented TCP server on loopback; `onLine` answers each line the client sends. */
async function lineServer(
  greeting: string,
  onLine: (line: string, socket: Socket, state: { data: boolean }) => void,
): Promise<{ port: number; lines: string[]; server: NetServer }> {
  const lines: string[] = [];
  const server = createServer((socket) => {
    const state = { data: false };
    let buffer = "";
    socket.write(greeting);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      let at = buffer.indexOf("\r\n");
      while (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        lines.push(line);
        onLine(line, socket, state);
        at = buffer.indexOf("\r\n");
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { port: address.port, lines, server };
}

describe("IMAP and SMTP through the lazy imapflow and nodemailer paths", () => {
  test("the first IMAP connection loads imapflow, which speaks to the server; a refused login fails the connect", async () => {
    const imap = await lineServer("* OK [CAPABILITY IMAP4rev1] fake ready\r\n", (line, socket) => {
      const [tag, command] = line.split(" ");
      switch (command?.toUpperCase()) {
        case "CAPABILITY":
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
          break;
        case "LOGIN":
          socket.write(`${tag} NO [AUTHENTICATIONFAILED] bad credentials\r\n`);
          break;
        case "LOGOUT":
          socket.write(`* BYE\r\n${tag} OK bye\r\n`);
          socket.end();
          break;
        default:
          socket.write(`${tag} OK done\r\n`);
      }
    });
    try {
      const provider = createImapProvider();
      const error = await provider
        .connect({
          address: "me@example.test",
          auth: { kind: "password", user: "me@example.test", password: "wrong" },
          endpoint: {
            kind: "imap",
            imap: { host: "127.0.0.1", port: imap.port, tls: "none" },
            smtp: { host: "127.0.0.1", port: 1, tls: "none" },
          },
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(ProviderError);
      // imapflow 2 rejects a refused LOGIN with a plain Error (authenticationFailed: true), not
      // AuthenticationFailure, so it reaches connectClient as a network failure today.
      expect((error as ProviderError).message).toContain("Command failed");
      expect(imap.lines.some((l) => / LOGIN /i.test(l))).toBe(true);
    } finally {
      imap.server.close();
    }
  });

  test("the first send loads nodemailer and submits the message", async () => {
    let message = "";
    const smtp = await lineServer("220 fake ESMTP\r\n", (line, socket, state) => {
      if (state.data) {
        if (line === ".") {
          state.data = false;
          socket.write("250 queued\r\n");
        } else message += `${line}\n`;
        return;
      }
      const verb = line.split(" ")[0]?.toUpperCase();
      if (verb === "EHLO") socket.write("250-fake\r\n250 AUTH PLAIN\r\n");
      else if (verb === "AUTH") socket.write("235 ok\r\n");
      else if (verb === "DATA") {
        state.data = true;
        socket.write("354 go\r\n");
      } else if (verb === "QUIT") {
        socket.write("221 bye\r\n");
        socket.end();
      } else socket.write("250 ok\r\n");
    });
    const sender = createSmtpSender(
      { host: "127.0.0.1", port: smtp.port, tls: "none" },
      { kind: "password", user: "me@example.test", password: "secret" },
      "me@example.test",
    );
    try {
      const mime = await composeMime({
        from: { name: "Me", email: "me@example.test" },
        to: [{ name: "You", email: "you@example.test" }],
        subject: "Lazy",
        text: "Sent through a transport made on first use.",
      });
      const result = await sender.send(mime);
      expect(result.accepted).toEqual(["you@example.test"]);
      expect(smtp.lines.some((l) => l.startsWith("RCPT TO:<you@example.test>"))).toBe(true);
      expect(message).toContain("Subject: Lazy");
    } finally {
      sender.close();
      smtp.server.close();
    }
  });
});
