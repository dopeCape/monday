// A Session's transcript, loaded for the composer, says when each turn was
// sent and each answer stored; the transcript a runtime reads does not.

import { describe, expect, test } from "bun:test";
import { createMemorySessionStore, stampEvent } from "../src/intelligence/agent/sessions.ts";

const T0 = new Date("2026-09-17T10:00:00Z");
const T1 = new Date("2026-09-17T10:00:05Z");

describe("transcript times", () => {
  test("a user or text event is stamped with the time it was stored; other kinds are not", () => {
    expect(stampEvent({ kind: "user", id: "u", text: "hi" }, T0)).toEqual({
      kind: "user",
      id: "u",
      text: "hi",
      at: T0.toISOString(),
    });
    expect(stampEvent({ kind: "text", id: "t", text: "hello", at: "earlier" }, T0)).toMatchObject({
      at: "earlier",
    });
    const error = { kind: "error" as const, id: "e", message: "x" };
    expect(stampEvent(error, T0)).toBe(error);
  });

  test("the memory store keeps each event's time and returns it only when asked", async () => {
    let now = T0;
    const store = createMemorySessionStore({ now: () => now });
    const session = await store.create("ws", { kind: "hosted", provider: "anthropic", model: "m" });
    await store.append(session.id, { kind: "user", id: "u1", text: "what came in?" });
    now = T1;
    await store.append(session.id, { kind: "text", id: "t1", text: "Two invoices." });
    expect(await store.events(session.id)).toEqual([
      { kind: "user", id: "u1", text: "what came in?" },
      { kind: "text", id: "t1", text: "Two invoices." },
    ]);
    expect(await store.events(session.id, { at: true })).toEqual([
      { kind: "user", id: "u1", text: "what came in?", at: T0.toISOString() },
      { kind: "text", id: "t1", text: "Two invoices.", at: T1.toISOString() },
    ]);
  });
});
