// The demo assistant (scripts/demo.ts, MONDAY_DEMO=1 only): a scripted model
// under the Hosted runtime so the browser demo can walk the onboarding
// conversation with no provider key. It holds a placeholder key for one
// provider, which every shared-key read falls back to; a call that carries
// that key is answered here from the transcript, any other goes to the real
// model underneath, so a key the user pastes in the demo still works.
//
// The script follows the onboarding prompt: onboarding_context first, then
// the questions one per turn, then (at automate) propose_groups built from
// the top senders the context reported, then set_keymap with the keymap in
// effect, then one closing line. Outside onboarding it says what it is.
// Nothing here is wired unless the entry is started with MONDAY_DEMO=1.

import type { HostedProvider, KeyProvider } from "@monday/shared";
import type { ProviderKeyStore } from "../keys.ts";
import type {
  AgentMessage,
  AgentToolCall,
  ChatModel,
  ConverseCall,
  ConverseModel,
  ConverseResponse,
} from "./index.ts";

/** The placeholder key the demo shares for its provider; only this module answers calls that carry it. */
export const DEMO_KEY = "monday-demo-assistant";
/** The model name the demo reports, so the Meter and the header say what answered. */
export const DEMO_MODEL = "demo-assistant";

/** The onboarding questions, in the prompt's order. */
export const DEMO_QUESTIONS = [
  "Who are you and what do you do?",
  "What mail matters most to you?",
  "Which tools do you use: Slack, Notion, Drive, Discord?",
  "May monday learn your voice from your sent mail?",
  "May monday read the last 30 days of mail to propose Groups?",
] as const;

const USAGE = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One sender as onboarding_context words it: "Name <email> (n messages)". */
export interface DemoSender {
  name: string;
  email: string;
  messages: number;
}

/** The top senders out of onboarding_context's text. */
export function sendersFromContext(text: string): DemoSender[] {
  const line = text.split("\n").find((l) => l.startsWith("Top senders:"));
  if (!line) return [];
  const out: DemoSender[] = [];
  for (const m of line.matchAll(/([^;:]+?) <([^>]+)> \((\d+) messages?\)/g)) {
    out.push({ name: (m[1] ?? "").trim(), email: (m[2] ?? "").trim(), messages: Number(m[3]) });
  }
  return out;
}

const NEWSLETTER = /^(digest|newsletter|news|updates|hello|noreply|no-reply)@/i;
const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "yahoo.com",
  "fastmail.com",
  "proton.me",
]);

const title = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** A Group proposal as propose_groups takes it. */
export interface DemoGroup {
  name: string;
  sentence: string;
  senders?: string[];
  domains?: string[];
}

/**
 * Three or four Groups from the senders: a newsletter sender joins one
 * Newsletters Group; a person on a personal domain (or a domain named after
 * them) gets a Group of their own; anyone else, a Group for their
 * organization. Senders the user named as mattering come first.
 */
export function proposeFromSenders(senders: readonly DemoSender[], named = ""): DemoGroup[] {
  const lower = named.toLowerCase();
  const ordered = [...senders].sort((a, b) => {
    const an = a.name && lower.includes(a.name.toLowerCase()) ? 1 : 0;
    const bn = b.name && lower.includes(b.name.toLowerCase()) ? 1 : 0;
    return bn - an || b.messages - a.messages;
  });
  const groups: DemoGroup[] = [];
  const newsletters = ordered.filter((s) => NEWSLETTER.test(s.email)).map((s) => s.email);
  for (const s of ordered) {
    if (groups.length >= 3) break;
    if (NEWSLETTER.test(s.email)) continue;
    const domain = s.email.split("@")[1] ?? "";
    const label = domain.split(".")[0] ?? domain;
    const person = s.name || s.email;
    const personal =
      PERSONAL_DOMAINS.has(domain) || (label.length > 2 && person.toLowerCase().includes(label));
    const name = personal ? person : title(label);
    if (groups.some((g) => g.name === name)) continue;
    groups.push(
      personal
        ? { name, sentence: `Everything from ${person}.`, senders: [s.email] }
        : { name, sentence: `Mail from anyone at ${name}.`, domains: [domain] },
    );
  }
  if (newsletters.length > 0) {
    groups.push({
      name: "Newsletters",
      sentence: "Digests and newsletters to read later.",
      senders: newsletters,
    });
  }
  return groups;
}

type ToolMessage = Extract<AgentMessage, { role: "tool" }>;
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

function called(messages: readonly AgentMessage[], tool: string): ToolMessage | undefined {
  return messages.find((m): m is ToolMessage => m.role === "tool" && m.name === tool);
}

let seq = 0;
const call = (name: string, args: Record<string, unknown>): AgentToolCall => ({
  id: `demo-${Date.now().toString(36)}-${++seq}`,
  name,
  args,
});

/** The next step of the onboarding conversation, from the transcript alone. */
export function onboardingStep(
  system: string,
  messages: readonly AgentMessage[],
): { text: string; toolCalls: AgentToolCall[] } {
  const level = /AI level is (off|assist|automate)/.exec(system)?.[1] ?? "assist";
  const max = Math.min(
    DEMO_QUESTIONS.length,
    Number(/at most (\d+) questions/.exec(system)?.[1] ?? DEMO_QUESTIONS.length),
  );
  const context = called(messages, "onboarding_context");
  if (!context) return { text: "", toolCalls: [call("onboarding_context", {})] };
  if (called(messages, "set_keymap")) {
    return {
      text: "You are all set. Type Set me up in the agent bar any time to run this again.",
      toolCalls: [],
    };
  }
  const asked = messages.filter(
    (m): m is AssistantMessage =>
      m.role === "assistant" && m.toolCalls.length === 0 && m.content.trim().endsWith("?"),
  ).length;
  if (asked < max) return { text: DEMO_QUESTIONS[asked] ?? "", toolCalls: [] };
  if (level === "automate" && !called(messages, "propose_groups")) {
    // The answer to "what matters most" puts those senders first.
    const answers = messages.filter((m) => m.role === "user").map((m) => m.content);
    const groups = proposeFromSenders(sendersFromContext(context.content), answers[2] ?? "");
    if (groups.length > 0) {
      return {
        text: "Here is how I would sort your mail. Nothing moves until you approve.",
        toolCalls: [call("propose_groups", { groups })],
      };
    }
  }
  const keymap = /Keymap in effect: (vim|gmail|natural)/.exec(context.content)?.[1] ?? "vim";
  return { text: "", toolCalls: [call("set_keymap", { keymap })] };
}

/**
 * The demo's converse: onboarding by script for a call with the demo key,
 * the real model for any other. Text streams in two pieces like a model's.
 */
export function createDemoConverse(real: ConverseModel, beatMs = 350): ConverseModel {
  return async (c: ConverseCall): Promise<ConverseResponse> => {
    if (c.key !== DEMO_KEY) return real(c);
    const onboarding = c.system.includes("onboarding_context");
    const step = onboarding
      ? onboardingStep(c.system, c.messages)
      : {
          text: "This is the demo assistant. It only runs the setup conversation; add a real runtime under Settings, AI and agent for everything else.",
          toolCalls: [],
        };
    // A beat so the thread shows it working, as a model would.
    await pause(beatMs);
    if (c.onText && step.text) {
      const half = Math.ceil(step.text.length / 2);
      c.onText(step.text.slice(0, half));
      await pause(beatMs / 3);
      c.onText(step.text.slice(half));
    }
    return { ...step, usage: USAGE, model: DEMO_MODEL };
  };
}

/**
 * The demo's single-shot calls. Routing's classify gets a low score for every
 * Group, so a proposed Group holds only what its senders or domains match
 * (the preview's move counts stay real); anything else (Briefs, rewrites)
 * says plainly that no model is behind it.
 */
export function createDemoChat(real: ChatModel): ChatModel {
  return async (c) => {
    if (c.key !== DEMO_KEY) return real(c);
    if (c.system.includes("route email threads")) {
      const labels = [...new Set(c.prompt.match(/\bG\d+\b/g) ?? [])];
      return {
        text: JSON.stringify(Object.fromEntries(labels.map((l) => [l, 0.05]))),
        usage: USAGE,
        model: DEMO_MODEL,
      };
    }
    throw new Error("the demo assistant only runs the setup conversation");
  };
}

/** The shared-key store with the demo's key behind every read of its provider. */
export function withDemoKey(store: ProviderKeyStore, provider: HostedProvider): ProviderKeyStore {
  return {
    put: (workspaceId, p, key) => store.put(workspaceId, p, key),
    remove: (p) => store.remove(p),
    async list() {
      const listed = await store.list();
      return listed.includes(provider) ? listed : [...listed, provider as KeyProvider];
    },
    async load(p) {
      const stored = await store.load(p);
      return stored ?? (p === provider ? DEMO_KEY : null);
    },
  };
}
