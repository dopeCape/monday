/// <reference types="bun-types" />
// The API transport's wake side: a Server that cannot push changes is polled
// on the sync.poll_seconds Setting (ADR 0004), read when the connection opens.

import { describe, expect, test } from "bun:test";
import type { Capabilities } from "@monday/shared";
import { createApi } from "../platform/api.ts";
import { apiTransport } from "./transport.ts";

const polling: Capabilities = {
  realtime: "polling",
} as Capabilities;

describe("apiTransport polling", () => {
  test("wakes the Store every poll interval from the Setting, and stops on close", async () => {
    const api = createApi(() => null);
    let seconds = 0.02;
    const transport = apiTransport(api, () => polling, { pollMs: () => seconds * 1000 });
    let wakes = 0;
    let opened = 0;
    const connection = transport.connect("ws", {
      onOpen: () => opened++,
      onWake: () => wakes++,
      onClose: () => {},
    });
    await new Promise((r) => setTimeout(r, 75));
    expect(opened).toBe(1);
    expect(wakes).toBeGreaterThanOrEqual(2);
    connection.close();
    const after = wakes;
    await new Promise((r) => setTimeout(r, 50));
    expect(wakes).toBe(after);
    // A changed Setting applies to the next connection.
    seconds = 10;
    let slow = 0;
    const next = transport.connect("ws", {
      onOpen: () => {},
      onWake: () => slow++,
      onClose: () => {},
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(slow).toBe(0);
    next.close();
  });
});
