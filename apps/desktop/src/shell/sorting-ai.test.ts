/// <reference types="bun-types" />
// Whether an AI can sort, through the seams: a coding agent CLI, a language
// model key, a TypeSafe key here or shared with the Server; a seam that fails
// reads as nothing found. Sections show only then, unless sections.require_ai
// is off, and never at Just mail.

import { describe, expect, test } from "bun:test";
import type { KeyProvider } from "@monday/shared";
import type { DeviceProviderKeys } from "../platform/providerKeys.ts";
import type { DetectedCli } from "../screens/settings/render.tsx";
import { readRuntimeState, sectionsShown } from "./sorting-ai.ts";

const keychain = (...have: KeyProvider[]): DeviceProviderKeys => ({
  get: async (p) => (have.includes(p) ? "key" : null),
  set: async () => {},
  remove: async () => {},
  resolver: async () => null,
  share: async () => false,
  unshare: async () => {},
});
const cli = (status: DetectedCli["status"]): DetectedCli => ({
  cli: "claude-code",
  version: null,
  path: null,
  status,
});

describe("readRuntimeState", () => {
  test("nothing at hand reads as nothing, and a failing seam does not throw", async () => {
    expect(await readRuntimeState({ runtimes: null, keys: null, shared: null })).toEqual({
      cli: false,
      language: false,
      judge: false,
    });
    const failing = await readRuntimeState({
      runtimes: { detect: () => Promise.reject(new Error("no spawn")) },
      keys: { ...keychain(), get: () => Promise.reject(new Error("locked")) },
      shared: () => Promise.reject(new Error("offline")),
    });
    expect(failing).toEqual({ cli: false, language: false, judge: false });
  });

  test("a coding agent, a language model key and a shared TypeSafe key each count", async () => {
    const found = await readRuntimeState({
      runtimes: { detect: async () => [cli("connected")] },
      keys: keychain("openrouter"),
      shared: async () => ({ shared: ["typesafe"] }),
    });
    expect(found).toEqual({ cli: true, language: true, judge: true });
    const missing = await readRuntimeState({
      runtimes: { detect: async () => [cli("missing")] },
      keys: null,
      shared: null,
    });
    expect(missing.cli).toBe(false);
  });
});

describe("sectionsShown", () => {
  const none = { cli: false, language: false, judge: false };
  test("with sections.require_ai on, only an AI that can sort at a level above Just mail shows them", () => {
    expect(sectionsShown({ requireAi: true, level: "automate", state: none })).toBe(false);
    expect(sectionsShown({ requireAi: true, level: "automate", state: null })).toBe(false);
    for (const state of [
      { ...none, judge: true },
      { ...none, language: true },
      { ...none, cli: true },
    ]) {
      expect(sectionsShown({ requireAi: true, level: "assist", state })).toBe(true);
      expect(sectionsShown({ requireAi: true, level: "off", state })).toBe(false);
    }
  });

  test("with it off, rule-only Sections always show", () => {
    expect(sectionsShown({ requireAi: false, level: "off", state: null })).toBe(true);
  });
});
