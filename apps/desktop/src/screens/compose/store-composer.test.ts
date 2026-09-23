/// <reference types="bun-types" />
// The Composer over the Store with the fake Server (ADR 0009, ADR 0010): a
// Draft saved offline lands in the Cache at once and replays on reconnect,
// Send is the send.schedule intent with a client-minted id, Undo cancels
// before run_at, the feed's draft and send rows fill the Cache, uploads
// report progress per chunk, and the reader seam fills bodies on open.

import { describe, expect, test } from "bun:test";
import type { DraftContent } from "@monday/shared";
import { bunDriver } from "../../store/bun-driver.ts";
import { createFakeStore, type FakeStore } from "../../store/fake.ts";
import { fixtureSeed } from "../../store/seed.ts";
import { createStoreInbox } from "../inbox/store-inbox.ts";
import { createStoreComposer } from "./store-composer.ts";

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await tick();
  }
  throw new Error("condition not met");
}

async function open(): Promise<FakeStore> {
  return createFakeStore({
    driver: bunDriver(),
    seed: fixtureSeed(),
    backoff: { minMs: 5, maxMs: 20 },
  });
}

const content = (over: Partial<DraftContent> = {}): DraftContent => ({
  threadId: null,
  kind: "new",
  inReplyToMessageId: null,
  to: [{ name: "Aoife", email: "aoife@northlight.dev" }],
  cc: [],
  bcc: [],
  subject: "Hello",
  bodyHtml: "<p>Hi</p>",
  bodyText: "Hi",
  attachments: [],
  ...over,
});

describe("the Store composer", () => {
  test("a Draft saved offline is in the Cache at once and reaches the Server on reconnect", async () => {
    const { store, server, content: transport } = await open();
    let ids = 0;
    const composer = await createStoreComposer(store, transport, {
      address: "tejas@genai-labs.io",
      id: () => `send-${++ids}`,
    });
    // The fixture seeds one Draft; it is listed before any save.
    expect(composer.drafts().map((d) => d.id)).toEqual(["d1"]);

    server.offline = true;
    await composer.save("d2", content());
    expect(composer.draft("d2")?.subject).toBe("Hello");
    expect(composer.draft("d2")?.status).toBe("open");
    expect(server.drafts.has("d2")).toBe(false);
    await store.sync();
    expect(server.drafts.has("d2")).toBe(false);

    server.offline = false;
    await store.sync();
    expect(server.drafts.get("d2")?.subject).toBe("Hello");
    expect(server.receivedDrafts.map((i) => i.kind)).toEqual(["draft.save"]);
    // The feed row for our own save keeps the local content.
    expect(composer.draft("d2")?.bodyHtml).toBe("<p>Hi</p>");
    const rows = await store.query<{ content_stale: number }>(
      "select content_stale from drafts where id = 'd2'",
    );
    expect(rows[0]?.content_stale).toBe(0);
    composer.close();
    await store.close();
  });

  test("Send schedules with a client id; Undo cancels before run_at and reopens", async () => {
    const { store, server, content: transport } = await open();
    let ids = 0;
    const composer = await createStoreComposer(store, transport, {
      address: "tejas@genai-labs.io",
      id: () => `send-${++ids}`,
    });
    await composer.save("d3", content());
    await store.sync();
    const { sendId, runAt } = await composer.send("d3", { delaySeconds: 30 });
    expect(sendId).toBe("send-1");
    // Locally the send is pending and the Draft is held before the Server answers.
    expect(composer.sends()[0]).toMatchObject({ id: "send-1", status: "scheduled", draftId: "d3" });
    expect(composer.draft("d3")?.status).toBe("scheduled");
    await store.sync();
    expect(server.sends.get("send-1")?.runAt).toBe(runAt);
    expect(server.drafts.get("d3")?.status).toBe("scheduled");

    await composer.cancel("send-1");
    expect(composer.sends()[0]?.status).toBe("cancelled");
    expect(composer.draft("d3")?.status).toBe("open");
    await store.sync();
    expect(server.sends.get("send-1")?.status).toBe("cancelled");
    expect(server.drafts.get("d3")?.status).toBe("open");

    // A replayed schedule is idempotent; once run, the Draft is sent and leaves the list.
    const again = await composer.send("d3", { delaySeconds: 0 });
    await store.sync();
    expect(server.runDueSends(new Date(Date.parse(again.runAt) + 1))).toBe(1);
    await store.sync();
    await until(() => composer.sends().find((s) => s.id === again.sendId)?.status === "sent");
    expect(composer.drafts().some((d) => d.id === "d3")).toBe(false);
    composer.close();
    await store.close();
  });

  test("a send.schedule made offline enters the undo window when it reaches the Server", async () => {
    const { store, server, content: transport } = await open();
    let ids = 0;
    const composer = await createStoreComposer(store, transport, {
      address: "tejas@genai-labs.io",
      id: () => `send-${++ids}`,
    });
    server.offline = true;
    await composer.save("d4", content());
    const { sendId } = await composer.send("d4", { delaySeconds: 30 });
    expect(composer.sends()[0]?.status).toBe("scheduled");
    await store.sync();
    expect(server.received.length + server.receivedDrafts.length).toBe(0);
    server.offline = false;
    const result = await store.sync();
    expect(result.pushed).toBe(2);
    expect(server.receivedDrafts.map((i) => i.kind)).toEqual(["draft.save", "send.schedule"]);
    expect(server.sends.get(sendId)?.status).toBe("scheduled");
    composer.close();
    await store.close();
  });

  test("a Draft written elsewhere arrives as headers and its content is fetched on open", async () => {
    const { store, server, content: transport } = await open();
    const composer = await createStoreComposer(store, transport, {
      address: "tejas@genai-labs.io",
    });
    // Another Device saved a Draft: the feed carries its headers only.
    server.applyDraftIntent({
      kind: "draft.save",
      draftId: "elsewhere",
      at: new Date().toISOString(),
      actor: "user",
      content: content({ subject: "From my phone", bodyHtml: "<p>phone</p>", bodyText: "phone" }),
    });
    await store.sync();
    await until(() => composer.draft("elsewhere") !== undefined);
    expect(composer.draft("elsewhere")?.subject).toBe("");
    const full = await composer.ensureContent("elsewhere");
    expect(full?.subject).toBe("From my phone");
    expect(full?.bodyHtml).toBe("<p>phone</p>");
    await until(() => composer.draft("elsewhere")?.subject === "From my phone");
    composer.close();
    await store.close();
  });

  test("uploads report progress per chunk and the reply-all choice is remembered", async () => {
    const { store, content: transport } = await open();
    const composer = await createStoreComposer(store, transport, {
      address: "tejas@genai-labs.io",
    });
    const seen: number[] = [];
    const done = await composer.upload(
      {
        name: "big.bin",
        mediaType: "application/octet-stream",
        bytes: new Uint8Array(3 * 1024 * 1024),
      },
      (f) => seen.push(Number(f.toFixed(2))),
    );
    expect(seen).toEqual([0.33, 0.67, 1]);
    expect(done.blobId).toBe("blob-1");
    expect(done.size).toBe(3 * 1024 * 1024);

    expect(composer.replyAllFor("e1")).toBeNull();
    await composer.setReplyAllFor("e1", true);
    expect(composer.replyAllFor("e1")).toBe(true);
    composer.close();
    const reopened = await createStoreComposer(store, transport, {
      address: "tejas@genai-labs.io",
    });
    expect(reopened.replyAllFor("e1")).toBe(true);
    expect(reopened.participants().some((p) => p.email === "aoife@northlight.dev")).toBe(true);
    reopened.close();
    await store.close();
  });
});

describe("the Store reader", () => {
  test("opening a Thread fills headers, attachments and bodies into the Cache", async () => {
    const { store, content: transport } = await open();
    // Empty the bodies the seed put in, as a first sync would leave them.
    await store.query("update messages set body_text = null, body_html = null");
    await store.query("delete from attachments");
    const inbox = await createStoreInbox(store, { content: transport });
    const seen: number[] = [];
    const un = inbox.watchMessages("e1", () => seen.push(inbox.messages("e1").length));
    await until(() => inbox.messages("e1").length === 3);
    expect(inbox.messages("e1").every((m) => m.bodyText === undefined)).toBe(true);
    await inbox.openThread("e1");
    await until(() => inbox.messages("e1").every((m) => m.bodyText !== undefined));
    const last = inbox.messages("e1")[2];
    expect(last?.bodyText).toContain("take-home");
    expect(last?.attachments.map((a) => a.name)).toEqual([
      "take-home-writeup.pdf",
      "sync-model.png",
    ]);
    const bytes = await inbox.attachmentBytes(last?.attachments[0]?.id ?? "");
    expect(bytes.mediaType).toBe("application/pdf");
    un();
    inbox.close();
    await store.close();
  });

  test("the writing assist goes to the Server with the Workspace, and is absent without the route", async () => {
    const { store, content: transport } = await open();
    const asked: unknown[] = [];
    const composer = await createStoreComposer(
      store,
      {
        ...transport,
        draftAssist: async (request) => {
          asked.push(request);
          return { text: "Shorter.", voice: false };
        },
        draftAssistAvailable: async () => true,
      },
      { address: "tejas@genai-labs.io" },
    );
    expect(await composer.assistAvailable?.()).toBe(true);
    const answer = await composer.assist?.({ action: "shorter", text: "A long text." });
    expect(answer?.text).toBe("Shorter.");
    expect(asked).toEqual([
      { action: "shorter", text: "A long text.", workspace: store.workspaceId },
    ]);
    const { draftAssist: _a, draftAssistAvailable: _b, ...without } = transport;
    const plain = await createStoreComposer(store, without, { address: "tejas@genai-labs.io" });
    expect(plain.assist).toBeUndefined();
    composer.close();
    plain.close();
    store.close();
  });
});
