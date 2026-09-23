// The composer's writing assist over its routes: it says whether it can answer
// (the AI level, the Setting, a key), answers one request as plain text with
// the menu item's instruction and the text, meters it as the draft-in-voice
// Task, and writes in the Voice profile when the user has one switched on.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, AiLevel, DraftAssistRequest } from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys } from "../src/crypto/keys.ts";
import { actionLine, cleanAnswer } from "../src/intelligence/compose-assist.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createFakeChat } from "../src/intelligence/runtime/fake/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const SIDECAR_TOKEN = "per-launch-token";

describe("the writing assist", () => {
  let db: TestDatabase;
  let keys: Keys;
  let store: Mailstore;
  let intelligence: Intelligence;
  let chat: ReturnType<typeof createFakeChat>;
  let app: Hono<AppEnv>;
  let workspaceId = "";
  let level: AiLevel = "assist";
  const NOW = new Date("2026-09-20T10:00:00Z");

  const account: Account = {
    id: "acct-assist",
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
  };

  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SIDECAR_TOKEN}`,
        ...(init.headers ?? {}),
      },
    });
  const send = (path: string, body: unknown, method = "POST") =>
    request(path, { method, body: JSON.stringify(body) });

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    chat = createFakeChat('```\n"Thanks, Kenji. The cap works for us."\n```');
    intelligence = createIntelligence({
      level: async () => level,
      db: db.handle.db,
      mailstore: store,
      chat: chat.chat,
      now: () => NOW,
    });
    const auth = createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN });
    app = createApp({
      db: db.handle.db,
      auth,
      mode: "sidecar",
      keys,
      mailstore: store,
      intelligence,
      remoteAddress: () => "127.0.0.1",
    });
    workspaceId = (await store.createWorkspace(account)).id;
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  const ask = (patch: Partial<DraftAssistRequest> = {}) =>
    send("/assist/draft", {
      workspace: workspaceId,
      action: "shorter",
      text: "Kenji, thank you so much for turning v3 around so quickly. The 1x pro-rata cap is fine with us.",
      subject: "Re: Term sheet",
      to: ["kenji@meridianfund.co"],
      ...patch,
    });

  test("says it cannot answer without a key, and why", async () => {
    const res = await request(`/assist/draft?workspace=${workspaceId}`);
    expect(await res.json()).toEqual({
      available: false,
      reason: "no_shared_key",
      provider: "anthropic",
    });
    const run = await ask();
    expect(run.status).toBe(409);
    expect(await run.json()).toEqual({ error: "no_shared_key", provider: "anthropic" });
    expect(chat.calls).toHaveLength(0);
  });

  test("answers as plain text with the menu item's line, and meters the draft-in-voice Task", async () => {
    await send("/keys/anthropic", { workspace: workspaceId, key: "sk-ant-assist" }, "PUT");
    expect(await (await request(`/assist/draft?workspace=${workspaceId}`)).json()).toEqual({
      available: true,
    });
    const res = await ask();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      text: "Thanks, Kenji. The cap works for us.",
      voice: false,
    });
    const call = chat.calls.at(-1);
    expect(call?.prompt).toContain("Make it shorter.");
    expect(call?.prompt).toContain("thank you so much for turning v3");
    expect(call?.prompt).toContain("Subject: Re: Term sheet");
    expect(call?.system).toContain("You edit one email the user is writing.");
    const month = await intelligence.meter.month(workspaceId, "2026-09");
    expect(month.lines.map((l) => l.task)).toContain("draft-in-voice");
  });

  test("a selection, a translation and a free instruction say so in the prompt", async () => {
    await ask({ action: "translate", language: "German", selection: true });
    expect(chat.calls.at(-1)?.prompt).toContain("Translate it into German.");
    expect(chat.calls.at(-1)?.prompt).toContain("a selection inside a longer email");
    await ask({ action: "instruction", instruction: "make this sound less defensive" });
    expect(chat.calls.at(-1)?.prompt).toContain("make this sound less defensive");
  });

  test("writes in the Voice profile when it is on", async () => {
    await intelligence.voice.put(workspaceId, {
      description: "Short sentences, first names, no exclamation marks.",
      excerpts: ["Works for me. T."],
      enabled: true,
    });
    const res = await ask({ action: "friendlier" });
    expect(((await res.json()) as { voice: boolean }).voice).toBe(true);
    expect(chat.calls.at(-1)?.system).toContain("Short sentences, first names");
    expect(chat.calls.at(-1)?.system).toContain("Works for me. T.");
  });

  test("at AI level off nothing is asked", async () => {
    level = "off";
    try {
      const before = chat.calls.length;
      expect(await (await request(`/assist/draft?workspace=${workspaceId}`)).json()).toEqual({
        available: false,
        reason: "ai_off",
      });
      const res = await ask();
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "ai_off" });
      expect(chat.calls.length).toBe(before);
    } finally {
      level = "assist";
    }
  });

  test("the answer loses fences and wrapping quotes; each action has its line", () => {
    expect(cleanAnswer('"Hello there."')).toBe("Hello there.");
    expect(cleanAnswer("```text\nHi\n```")).toBe("Hi");
    expect(actionLine({ workspace: "w", action: "grammar", text: "" })).toContain(
      "Change nothing else",
    );
    expect(actionLine({ workspace: "w", action: "continue", text: "" })).toContain(
      "only the new text",
    );
  });
});
