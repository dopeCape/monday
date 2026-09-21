// Custom actions on the Device (CONTEXT.md "Custom action"; docs/spec/inbox.md,
// Reader): a button the user defined for the Threads of a Group or Section
// runs an ordinary tool call with its Tier (ADR 0002), over the same seams
// the Brief chips use (brief-actions.ts). A forward or a draft opens compose
// with the recipients and text filled in and never sends; archive, snooze,
// move, tag and trash apply through InboxActions with Undo; a tool promoted
// to always-ask, or trash, confirms first. What the Device cannot run (a Tag
// it does not have, a tool it does not know) reports `unavailable`, and the
// screen offers the composer, whose Server host runs the same tool.
// Arguments hold the Workflow templates ({{thread.subject}}, {{thread.from}},
// {{thread.id}}), rendered here with renderTemplate before the tool runs.

import type { CustomActionSetting, Group, Person, Tag, Thread, Tier } from "@monday/shared";
import { renderTemplate, TOOL_TIERS, tierOf } from "@monday/shared";
import type { InboxActions, UndoToken } from "./actions.ts";
import type { ComposeSeed } from "./brief-actions.ts";

/** The Tier a custom action renders with: the tool's own, raised by the action or the agent.always_ask Setting. */
export function customActionTier(
  action: CustomActionSetting,
  alwaysAsk: readonly string[] = [],
): Tier {
  if (action.tier === "always-ask" || alwaysAsk.includes(action.tool)) return "always-ask";
  const base = TOOL_TIERS[action.tool];
  return base ? tierOf(base) : "always-ask";
}

/** The action's arguments with every template rendered against the Thread. */
export function renderActionArgs(
  action: CustomActionSetting,
  thread: Thread,
  groupName?: string | null,
): Record<string, unknown> {
  const first = thread.participants[0];
  const ctx = {
    thread: {
      id: thread.id,
      subject: thread.subject,
      from: first ? (first.name ? `${first.name} <${first.email}>` : first.email) : "",
      fromEmail: first?.email,
      group: groupName ?? thread.group,
      tags: thread.tags,
    },
    run: { id: "", workflow: "" },
    steps: {},
  };
  const render = (value: unknown): unknown => {
    if (typeof value === "string") return renderTemplate(value, ctx);
    if (Array.isArray(value)) return value.map(render);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v)]));
    }
    return value;
  };
  return render(action.args) as Record<string, unknown>;
}

function toPerson(value: unknown): Person | null {
  if (typeof value === "string") {
    const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
    const email = (m?.[2] ?? value).trim();
    return email ? { name: m?.[1] ?? "", email } : null;
  }
  if (value && typeof value === "object" && typeof (value as Person).email === "string") {
    const p = value as Person;
    return { name: typeof p.name === "string" ? p.name : "", email: p.email };
  }
  return null;
}

function toPersons(value: unknown): Person[] {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return list.map(toPerson).filter((p): p is Person => p !== null);
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : typeof value === "string"
      ? [value]
      : [];

/** What running a custom action came to. */
export type CustomActionOutcome =
  /** Applied on the Device, with Undo when reversible; or handed to compose, which the user still sends. */
  | { ok: true; handed: "compose" | "applied"; undo: UndoToken | null }
  /** The Device cannot run it; the composer's Server host can. */
  | { ok: false; reason: "unavailable" | "unknown_tool" | "bad_argument" };

export interface CustomActionRunnerDeps {
  inbox: InboxActions;
  /** Opens compose on the Thread with the seed; the user still sends (ADR 0002). */
  compose(kind: "reply" | "forward", threadId: string, seed: ComposeSeed): void;
  /** The Workspace's Groups, so move_threads may name one either way. */
  groups(): readonly Group[];
  /** The Workspace's Tags, so tag_threads may name them; a name the Device lacks is unavailable. */
  tags(): readonly Tag[];
}

export interface CustomActionRunner {
  run(action: CustomActionSetting, thread: Thread): Promise<CustomActionOutcome>;
}

export function createCustomActionRunner(deps: CustomActionRunnerDeps): CustomActionRunner {
  const groupId = (ref: unknown): string | null | undefined => {
    if (ref === null) return null;
    if (typeof ref !== "string" || !ref.trim()) return undefined;
    const want = ref.trim().toLowerCase();
    const found =
      deps.groups().find((g) => g.id.toLowerCase() === want) ??
      deps.groups().find((g) => g.name.toLowerCase() === want);
    return found?.id;
  };
  return {
    async run(action, thread) {
      const groupName = thread.group
        ? (deps.groups().find((g) => g.id === thread.group)?.name ?? null)
        : null;
      const args = renderActionArgs(action, thread, groupName);
      const id = thread.id;
      switch (action.tool) {
        case "forward_thread": {
          const to = toPersons(args.to);
          if (to.length === 0) return { ok: false, reason: "bad_argument" };
          deps.compose("forward", id, {
            to,
            ...(typeof args.note === "string" && args.note ? { opening: args.note } : {}),
          });
          return { ok: true, handed: "compose", undo: null };
        }
        case "draft_message": {
          const to = toPersons(args.to);
          deps.compose(args.kind === "forward" ? "forward" : "reply", id, {
            ...(to.length ? { to } : {}),
            ...(typeof args.body === "string" && args.body ? { opening: args.body } : {}),
          });
          return { ok: true, handed: "compose", undo: null };
        }
        case "archive_threads":
          return { ok: true, handed: "applied", undo: await deps.inbox.archive([id]) };
        case "trash_threads":
          return { ok: true, handed: "applied", undo: await deps.inbox.delete([id]) };
        case "snooze_threads": {
          const until = new Date(typeof args.until === "string" ? args.until : "");
          if (Number.isNaN(until.getTime())) return { ok: false, reason: "bad_argument" };
          return { ok: true, handed: "applied", undo: await deps.inbox.snooze([id], until) };
        }
        case "move_threads": {
          const target = groupId(args.group);
          if (target === undefined) return { ok: false, reason: "bad_argument" };
          return { ok: true, handed: "applied", undo: await deps.inbox.moveToGroup([id], target) };
        }
        case "tag_threads": {
          if (!deps.inbox.setTags) return { ok: false, reason: "unavailable" };
          const byName = new Map(deps.tags().map((t) => [t.name.toLowerCase(), t.id]));
          const add = strings(args.add).map((n) => byName.get(n.trim().toLowerCase()));
          const remove = strings(args.remove).map((n) => byName.get(n.trim().toLowerCase()));
          // A Tag the Cache does not have cannot be made here; the Server host creates it.
          if (add.some((t) => t === undefined)) return { ok: false, reason: "unavailable" };
          const removeSet = new Set(remove.filter((t): t is string => t !== undefined));
          const next = [
            ...new Set([
              ...thread.tags.filter((t) => !removeSet.has(t)),
              ...add.filter((t): t is string => t !== undefined),
            ]),
          ];
          return { ok: true, handed: "applied", undo: await deps.inbox.setTags([id], next) };
        }
        default:
          return { ok: false, reason: "unknown_tool" };
      }
    },
  };
}
