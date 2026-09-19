// The Voice profile builder's pure parts: a sent Message's own words, and
// the model's answer checked for what the profile needs.

import { describe, expect, test } from "bun:test";
import { ownText, parseVoiceOutput, VoiceOutputError } from "../src/intelligence/voice.ts";

describe("ownText", () => {
  test("keeps what the user wrote and drops the quoted history under it", () => {
    const text = [
      "Hi Sam,",
      "",
      "Thursday works.",
      "",
      "Me",
      "",
      "On Tue, 16 Sep 2026, Sam <sam@example.test> wrote:",
      "> Can we do Thursday?",
      "> Sam",
    ].join("\n");
    expect(ownText(text)).toBe("Hi Sam,\n\nThursday works.\n\nMe");
  });

  test("drops quoted lines even without a wrote line, and squeezes blank runs", () => {
    expect(ownText("Yes.\n\n\n\n> earlier\n> lines\n\nThanks")).toBe("Yes.\n\nThanks");
    expect(ownText("   \n")).toBe("");
  });
});

describe("parseVoiceOutput", () => {
  test("reads the last JSON object and caps the excerpts", () => {
    const out = parseVoiceOutput(
      'Sure. {"description": " Warm and brief. ", "excerpts": ["a", " b ", 3, "", "c"]}',
      2,
    );
    expect(out).toEqual({ description: "Warm and brief.", excerpts: ["a", "b"] });
  });

  test("refuses an answer without a description", () => {
    expect(() => parseVoiceOutput("no json here", 5)).toThrow(VoiceOutputError);
    expect(() => parseVoiceOutput('{"excerpts": []}', 5)).toThrow(VoiceOutputError);
    expect(() => parseVoiceOutput('{"description": ""}', 5)).toThrow(VoiceOutputError);
    expect(() => parseVoiceOutput("{not json}", 5)).toThrow(VoiceOutputError);
  });
});
