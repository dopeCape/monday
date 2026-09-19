/// <reference types="bun-types" />
// The Device's AgentClient through its seam: a Local Session's turn goes to
// the CLI adapter over the fake process runner, and every way a Local
// runtime cannot serve reaches the composer in plain words from the
// Settings: ruled out by detection, no Sidecar, a spawn that fails.

import { describe, expect, test } from "bun:test";
import type { AgentEvent, RuntimeStatus, SessionSummary, Settings } from "@monday/shared";
import { defaultSettings } from "@monday/shared";
import type { Api } from "../platform/api.ts";
import { deviceAgentClient } from "./deviceClient.ts";
import type { SessionLink } from "./runtimes/link.ts";
import { fakeProcessRunner } from "./runtimes/process.ts";

const NOW = new Date("2026-09-19T10:00:00Z");

/** The Server's agent routes, faked: one Local Session on Claude Code, nothing else. */
function fakeApi(session: SessionSummary): Api {
  const agent = {
    sessions: async () => ({ sessions: [session] }),
    createSession: async () => session,
    session: async () => ({ session, events: [] as AgentEvent[] }),
    switchRuntime: async () => ({ kind: "runtime", id: "r", runtime: session.runtime }),
    turn: async () => {},
    approve: async () => {},
    undo: async () => {
      throw new Error("not in this test");
    },
    live: () => () => {},
    appendEvent: async () => {},
  };
  return { agent } as unknown as Api;
}

const link: SessionLink = {
  live: () => () => {},
  append: async () => {},
  approve: async () => {},
  switchRuntime: async () => ({
    kind: "runtime",
    id: "r",
    runtime: { kind: "local", cli: "claude-code" },
  }),
};

const session: SessionSummary = {
  id: "s1",
  workspaceId: "ws",
  runtime: { kind: "local", cli: "claude-code" },
  title: "",
  startedAt: NOW.toISOString(),
  lastActivity: NOW.toISOString(),
};

function client(over: {
  statusOf?: (cli: string) => RuntimeStatus | null;
  sidecar?: { port: number; token: string } | null;
  settings?: Partial<Settings>;
  spawnError?: string;
}) {
  const runner = fakeProcessRunner({
    claude: over.spawnError ? { spawnError: over.spawnError } : { greeting: [], exitCode: 0 },
  });
  return deviceAgentClient({
    api: fakeApi(session),
    runner: runner.runner,
    sidecar: () => (over.sidecar === undefined ? { port: 4242, token: "t" } : over.sidecar),
    settings: () => ({ ...defaultSettings(), ...over.settings }) as Settings,
    address: () => "me@example.test",
    link,
    statusOf: (cli) => over.statusOf?.(cli) ?? null,
    now: () => NOW,
  });
}

describe("the Device's AgentClient on a Local runtime", () => {
  test("a CLI detection ruled out refuses the turn with the detection's own reason", async () => {
    const c = client({
      statusOf: () => ({
        cli: "claude-code",
        command: "claude",
        installed: true,
        version: "2.1",
        loggedIn: false,
        reason:
          "Claude Code is installed but not logged in. Sign in from a terminal, then try again.",
      }),
    });
    await expect(c.turn("s1", "hello", {}, () => {})).rejects.toThrow(
      "Claude Code is installed but not logged in. Sign in from a terminal, then try again.",
    );
  });

  test("with no Sidecar running the turn says so, from the Setting", async () => {
    const c = client({ sidecar: null });
    await expect(c.turn("s1", "hello", {}, () => {})).rejects.toThrow(
      "The Sidecar is not running, so a Local runtime cannot reach monday's tools. Start it under Sync server.",
    );
  });

  test("a spawn that fails names the CLI and what went wrong, from the Setting", async () => {
    const c = client({ spawnError: "program not found: claude" });
    await expect(c.turn("s1", "hello", {}, () => {})).rejects.toThrow(
      "Claude Code could not start: program not found: claude",
    );
    // The wording is the user's to change.
    const reworded = client({
      spawnError: "program not found: claude",
      settings: { "strings.agent.start_failed": "No {runtime} here ({message})" },
    });
    await expect(reworded.turn("s1", "hello", {}, () => {})).rejects.toThrow(
      "No Claude Code here (program not found: claude)",
    );
  });
});
