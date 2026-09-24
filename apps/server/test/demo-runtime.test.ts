// The browser demo's scripted assistant (runtime/demo.ts) through its seams:
// the converse model walks the onboarding conversation from the transcript
// alone (context, the questions, Groups at automate, the keymap in effect,
// the closing line), hands any other key to the real model, and the key
// store falls back to the placeholder key only for its provider.

import { describe, expect, test } from "bun:test";
import type { KeyProvider } from "@monday/shared";
import type { ProviderKeyStore } from "../src/intelligence/keys.ts";
import {
  createDemoChat,
  createDemoConverse,
  DEMO_KEY,
  DEMO_QUESTIONS,
  proposeFromSenders,
  sendersFromContext,
  withDemoKey,
} from "../src/intelligence/runtime/demo.ts";
import type {
  AgentMessage,
  ConverseCall,
  ConverseResponse,
} from "../src/intelligence/runtime/index.ts";

const CONTEXT = [
  "AI level: automate.",
  "Keymap in effect: gmail.",
  "Threads synced: 24.",
  "Top senders: Aoife Byrne <aoife@northwind.test> (9 messages); Priya Raman <priya@raman.test> (6 messages); Mateo Silva <mateo@lumen.test> (4 messages); The Weekly <digest@theweekly.test> (2 messages).",
  "No Groups yet.",
].join("\n");

function system(level: string, questions = 5) {
  return `You are monday.\n\nThis Session is onboarding. The user's AI level is ${level}.\nAsk at most ${questions} questions. Start by calling onboarding_context once.`;
}

function callOf(sys: string, messages: AgentMessage[], key = DEMO_KEY): ConverseCall {
  return {
    provider: "anthropic",
    model: "claude",
    effort: "low",
    maxOutputTokens: 100,
    key,
    system: sys,
    messages,
    tools: [],
  };
}

/** Plays the conversation: each step's answer joins the transcript, tool calls get a result. */
async function play(level: string, answers: string[]) {
  const converse = createDemoConverse(async () => {
    throw new Error("the real model was called");
  }, 0);
  const messages: AgentMessage[] = [{ role: "user", content: "Set me up." }];
  const steps: ConverseResponse[] = [];
  const replies = [...answers];
  for (let i = 0; i < 20; i++) {
    const r = await converse(callOf(system(level), messages));
    steps.push(r);
    messages.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls });
    if (r.toolCalls.length > 0) {
      for (const c of r.toolCalls) {
        const content =
          c.name === "onboarding_context"
            ? CONTEXT
            : c.name === "propose_groups"
              ? "Created 3 Groups; 12 threads moved."
              : "Keymap: gmail.";
        messages.push({ role: "tool", toolCallId: c.id, name: c.name, content });
      }
      continue;
    }
    const next = replies.shift();
    if (next === undefined) break;
    messages.push({ role: "user", content: next });
  }
  return steps;
}

describe("the demo assistant", () => {
  test("at automate: context, the five questions in order, Groups from the senders, the keymap in effect, then the closing line", async () => {
    const steps = await play("automate", ["A studio", "Priya Raman", "Drive", "No", "Yes"]);
    expect(steps[0]?.toolCalls.map((c) => c.name)).toEqual(["onboarding_context"]);
    const questions = steps.filter((s) => s.toolCalls.length === 0 && s.text.endsWith("?"));
    expect(questions.map((s) => s.text)).toEqual([...DEMO_QUESTIONS]);
    const proposal = steps.find((s) => s.toolCalls[0]?.name === "propose_groups");
    const groups = proposal?.toolCalls[0]?.args.groups as Array<{ name: string }>;
    // The sender the user named comes first; the newsletter sender gets its own Group.
    expect(groups.map((g) => g.name)).toEqual(["Priya Raman", "Northwind", "Lumen", "Newsletters"]);
    const keymap = steps.find((s) => s.toolCalls[0]?.name === "set_keymap");
    expect(keymap?.toolCalls[0]?.args).toEqual({ keymap: "gmail" });
    expect(steps.at(-1)?.text).toContain("Set me up");
    expect(steps.at(-1)?.model).toBe("demo-assistant");
  });

  test("at assist: no Groups, straight to the keymap after the questions", async () => {
    const steps = await play("assist", ["A", "B", "C", "D", "E"]);
    expect(steps.some((s) => s.toolCalls[0]?.name === "propose_groups")).toBe(false);
    expect(steps.some((s) => s.toolCalls[0]?.name === "set_keymap")).toBe(true);
  });

  test("a call with any other key goes to the real model; outside onboarding it says what it is", async () => {
    const seen: string[] = [];
    const converse = createDemoConverse(async (c) => {
      seen.push(c.key);
      return {
        text: "real",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      };
    }, 0);
    const real = await converse(callOf(system("assist"), [], "sk-real"));
    expect(real.text).toBe("real");
    expect(seen).toEqual(["sk-real"]);
    const plain = await converse(callOf("You are monday.", [{ role: "user", content: "hi" }]));
    expect(plain.text).toContain("demo assistant");
  });

  test("routing's classify scores every Group low, so only header matches move; other single calls refuse", async () => {
    const chat = createDemoChat(async () => {
      throw new Error("the real model was called");
    });
    const call = {
      provider: "anthropic" as const,
      model: "claude",
      effort: "low" as const,
      maxOutputTokens: 100,
      key: DEMO_KEY,
    };
    const scored = await chat({
      ...call,
      system: "You route email threads into a user's Groups in a calm email client.",
      prompt: "Groups:\nG1: Northwind\nG2: Lumen\n\nThread:\n...",
    });
    expect(JSON.parse(scored.text)).toEqual({ G1: 0.05, G2: 0.05 });
    await expect(chat({ ...call, system: "Write a Brief.", prompt: "..." })).rejects.toThrow(
      "setup conversation",
    );
  });

  test("the key store lists the demo provider and falls back to the placeholder key only for it", async () => {
    const stored = new Map<KeyProvider, string>([["typesafe", "ts-1"]]);
    const inner: ProviderKeyStore = {
      put: async (_w, p, k) => void stored.set(p, k),
      remove: async (p) => void stored.delete(p),
      list: async () => [...stored.keys()],
      load: async (p) => stored.get(p) ?? null,
    };
    const keys = withDemoKey(inner, "anthropic");
    expect(await keys.list()).toEqual(["typesafe", "anthropic"]);
    expect(await keys.load("anthropic")).toBe(DEMO_KEY);
    expect(await keys.load("openai")).toBeNull();
    await keys.put("ws", "anthropic", "sk-real");
    expect(await keys.load("anthropic")).toBe("sk-real");
  });

  test("senders parse out of the context, and personal domains become a person's Group", () => {
    const senders = sendersFromContext(CONTEXT);
    expect(senders[0]).toEqual({ name: "Aoife Byrne", email: "aoife@northwind.test", messages: 9 });
    expect(
      proposeFromSenders([{ name: "Kim Lee", email: "kim@gmail.com", messages: 3 }]).map(
        (g) => g.sentence,
      ),
    ).toEqual(["Everything from Kim Lee."]);
  });
});
