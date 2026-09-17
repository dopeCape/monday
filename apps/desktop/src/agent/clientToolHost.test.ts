// The Device's ToolHost through its interface over the fixture Inbox and a
// Settings seam: the same filters the Server host answers, writes that go
// through InboxActions and leave an undo token each, Settings that the
// Config file pins refused where the Shell refuses them.

import { describe, expect, test } from "bun:test";
import { defaultSettings, type SettingKey, type Settings } from "@monday/shared";
import { threads as fixtureThreads } from "@monday/ui/fixtures";
import { fixtureInbox } from "../screens/inbox/actions.ts";
import type { SetResult } from "../shell/Shell.tsx";
import { createClientToolHost, type SettingsSeam } from "./clientToolHost.ts";

function settingsSeam(
  pinned: SettingKey[] = [],
): SettingsSeam & { writes: Array<[string, unknown]> } {
  const settings = defaultSettings();
  const pinnedSet = new Set(pinned);
  const writes: Array<[string, unknown]> = [];
  return {
    settings,
    pinned: pinnedSet,
    writes,
    async set<K extends SettingKey>(key: K, value: Settings[K]): Promise<SetResult> {
      if (pinnedSet.has(key))
        return { ok: false, reason: "pinned", message: `${key} is set in monday.toml` };
      settings[key] = value;
      writes.push([key, value]);
      return { ok: true };
    },
  };
}

describe("the client ToolHost", () => {
  test("lists and filters the Inbox's Threads and reads one with its Messages", async () => {
    const inbox = fixtureInbox();
    const host = createClientToolHost({ workspaceId: "ws", inbox, shell: settingsSeam() });
    const all = await host.listThreads({ limit: 100 });
    expect(all.length).toBe(inbox.threads().length);
    const newsletters = await host.listThreads({ section: "newsletters", limit: 100 });
    expect(newsletters.every((t) => t.section === "newsletters")).toBe(true);
    const first = fixtureThreads[0];
    if (!first) throw new Error("no fixture thread");
    const reading = await host.readThread(first.id);
    expect(reading?.subject).toBe(first.subject);
    expect(reading?.messages.length).toBeGreaterThan(0);
    expect((await host.threadsById([first.id, "nope"])).map((t) => t.id)).toEqual([first.id]);
    expect(await host.readThread("nope")).toBeNull();
    expect((await host.listSections()).map((s) => s.id)).toEqual(
      defaultSettings()["sections.order"],
    );
  });

  test("a batch of intents goes through InboxActions as one undoable action per kind", async () => {
    const inbox = fixtureInbox();
    const host = createClientToolHost({ workspaceId: "ws", inbox, shell: settingsSeam() });
    const ids = inbox
      .threads()
      .slice(0, 3)
      .map((t) => t.id);
    const { applied } = await host.applyIntents([
      ...ids.map((threadId) => ({ kind: "archive" as const, threadId })),
      { kind: "archive", threadId: "nope" },
    ]);
    expect(applied).toBe(3);
    expect(ids.every((id) => inbox.thread(id)?.archived)).toBe(true);
    expect(host.undoTokens).toHaveLength(1);
    await inbox.undo(host.undoTokens[0] as string);
    expect(ids.every((id) => inbox.thread(id)?.archived === false)).toBe(true);
    // The inverse intents the Activity log would replay also land on the seam.
    await host.applyIntents(ids.map((threadId) => ({ kind: "archive" as const, threadId })));
    await host.applyIntents(ids.map((threadId) => ({ kind: "unarchive" as const, threadId })));
    expect(ids.every((id) => inbox.thread(id)?.archived === false)).toBe(true);
    expect(host.undoTokens).toHaveLength(3);
  });

  test("Settings read through the Shell with pinning, and a pinned write is refused", async () => {
    const shell = settingsSeam(["appearance.mode"]);
    const host = createClientToolHost({ workspaceId: "ws", inbox: fixtureInbox(), shell });
    expect(await host.readSetting("appearance.mode")).toEqual({ value: "system", pinned: true });
    expect(await host.readSetting("appearance.palette")).toEqual({
      value: "graphite",
      pinned: false,
    });
    expect(await host.readSetting("nope")).toEqual({ value: undefined, pinned: false });
    await host.writeSetting("appearance.palette", "gruvbox");
    expect(shell.writes).toEqual([["appearance.palette", "gruvbox"]]);
    await expect(host.writeSetting("appearance.mode", "dark")).rejects.toThrow("monday.toml");
    await expect(host.writeSetting("nope", 1)).rejects.toThrow("unknown setting");
  });

  test("drafts and sends need the compose seam; without it they say so", async () => {
    const host = createClientToolHost({
      workspaceId: "ws",
      inbox: fixtureInbox(),
      shell: settingsSeam(),
    });
    await expect(
      host.createDraft({
        threadId: null,
        kind: "new",
        inReplyToMessageId: null,
        to: [],
        cc: [],
        bcc: [],
        subject: "",
        bodyHtml: "",
        bodyText: "",
        attachments: [],
      }),
    ).rejects.toThrow("not available");
    expect(await host.readDraft("d")).toBeNull();
    expect(await host.cancelSend("s")).toEqual({ applied: false });
  });
});
