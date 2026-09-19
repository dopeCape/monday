/// <reference types="bun-types" />
// The platform seam's pure parts and its fake: the recovery file round trip
// matches what the Rust side writes (src-tauri/src/rootkey.rs), the fake's
// config file, palette files, keychain and notifications behave like the
// host's, and every method the Tauri host has is on the fake too, so a test
// cannot pass against a seam the app does not have.

import { describe, expect, test } from "bun:test";
import { fakePlatform, type Platform, recoveryFileText, recoveryKeyOf } from "./tauri.ts";

const KEY = btoa(String.fromCharCode(...Uint8Array.from({ length: 32 }, (_, i) => i)));

describe("the recovery file", () => {
  test("round-trips the key and matches the Rust format line for line", () => {
    const text = recoveryFileText(KEY);
    expect(text.split("\n")).toEqual([
      "monday recovery key. This unlocks every message on your server. Keep it private; without it, a new install cannot read your mail.",
      KEY,
      "",
    ]);
    expect(recoveryKeyOf(text)).toBe(KEY);
    // Blank lines and whitespace around the key are forgiven; the wrong length is not.
    expect(recoveryKeyOf(`\n  ${KEY}  \n\n`)).toBe(KEY);
    expect(recoveryKeyOf("monday recovery key.\nabc\n")).toBeNull();
    expect(recoveryKeyOf("")).toBeNull();
    expect(recoveryKeyOf("not base64 at all!")).toBeNull();
  });
});

describe("fakePlatform", () => {
  test("has every method the Tauri host has", () => {
    const fake = fakePlatform();
    const expected: Array<keyof Platform> = [
      "readConfig",
      "writeConfig",
      "onConfigChanged",
      "readPaletteFile",
      "secretGet",
      "secretSet",
      "secretDelete",
      "sidecarInfo",
      "onSidecarReady",
      "openExternal",
      "network",
      "power",
      "recoveryFile",
      "importRecoveryKey",
      "notify",
      "spawn",
      "isTauri",
    ];
    for (const name of expected) expect(name in fake, name).toBe(true);
    expect(fake.isTauri).toBe(false);
  });

  test("the config file is watched in memory and a write tells the watcher", async () => {
    const fake = fakePlatform('[appearance]\nmode = "dark"\n');
    expect((await fake.readConfig()).exists).toBe(true);
    const seen: string[] = [];
    const stop = fake.onConfigChanged((f) => seen.push(f.text));
    await fake.writeConfig("");
    expect(seen).toEqual([""]);
    expect((await fake.readConfig()).exists).toBe(false);
    stop();
    await fake.writeConfig("x = 1");
    expect(seen).toEqual([""]);
  });

  test("palette files come from the options; anything else does not exist", async () => {
    const fake = fakePlatform("", { files: { "~/p.toml": 'name = "p"' } });
    expect(await fake.readPaletteFile("~/p.toml")).toEqual({
      path: "~/p.toml",
      exists: true,
      text: 'name = "p"',
    });
    expect((await fake.readPaletteFile("/nowhere")).exists).toBe(false);
  });

  test("the keychain and the recovery file", async () => {
    const fake = fakePlatform();
    expect(await fake.secretGet("k")).toBeNull();
    await fake.secretSet("k", "v");
    expect(await fake.secretGet("k")).toBe("v");
    await fake.secretDelete("k");
    expect(await fake.secretGet("k")).toBeNull();
    const file = await fake.recoveryFile();
    expect(recoveryKeyOf(file)).not.toBeNull();
    await fake.importRecoveryKey(recoveryFileText(KEY));
    expect(recoveryKeyOf(await fake.recoveryFile())).toBe(KEY);
    await expect(fake.importRecoveryKey("nope")).rejects.toThrow("not a recovery key");
    const locked = fakePlatform("", { rootKey: null });
    await expect(locked.recoveryFile()).rejects.toThrow("keychain unavailable");
  });

  test("notifications reach the sink a test gives", async () => {
    const shown: string[] = [];
    const fake = fakePlatform("", { notified: (title, body) => shown.push(`${title}: ${body}`) });
    await fake.notify("Standup", "in 10 minutes");
    expect(shown).toEqual(["Standup: in 10 minutes"]);
  });
});
