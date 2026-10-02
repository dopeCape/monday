// Mentions in the composer (Assistant UI's composer trigger popover with a
// mention adapter): typing @ lists Threads, Groups, Sections and people; a
// pick inserts a directive, `:thread[Subject]{name=id}`, that the Agent reads
// as a pointer (the system prompt Setting says how) and the user's bubble
// renders back as a chip. The screen provides what can be mentioned through
// ComposerMentionsContext, so every composer in the tree offers the same list.

import { unstable_defaultDirectiveFormatter } from "@assistant-ui/react";
import type { Group, Thread } from "@monday/shared";
import { Icon } from "@monday/ui";
import {
  ArrowBendUpLeftIcon,
  EnvelopeSimpleIcon,
  FolderSimpleIcon,
  type Icon as PhosphorIcon,
  RowsIcon,
  UserIcon,
} from "@phosphor-icons/react";
import { createContext, Fragment, useContext } from "react";
import { useComposerEnv } from "./context.tsx";

export type MentionKind = "thread" | "group" | "section" | "person";

export interface MentionItem {
  id: string;
  type: MentionKind;
  label: string;
  description?: string | undefined;
}

export const MENTION_KINDS: readonly MentionKind[] = ["thread", "group", "section", "person"];

/** What the @ list offers; empty without a provider (the onboarding conversation, tests). */
export const ComposerMentionsContext = createContext<readonly MentionItem[]>([]);

export function useMentionItems(): readonly MentionItem[] {
  return useContext(ComposerMentionsContext);
}

/** What a list row carries when it is dragged: its Thread, or the whole multi-select. */
export const THREAD_DRAG_TYPE = "application/x-monday-threads";

export interface DraggedThread {
  id: string;
  subject: string;
}

/** Puts dragged Threads on a drag; plain text too, so dropping elsewhere reads sensibly. */
export function writeThreadDrag(data: DataTransfer, threads: readonly DraggedThread[]): void {
  data.setData(THREAD_DRAG_TYPE, JSON.stringify(threads));
  data.setData("text/plain", threads.map((t) => t.subject).join("\n"));
  data.effectAllowed = "copy";
}

/** Whether a drag carries Threads (types are readable during dragover, the data only on drop). */
export function carriesThreads(data: DataTransfer | null): boolean {
  return !!data && [...data.types].includes(THREAD_DRAG_TYPE);
}

export function readThreadDrag(data: DataTransfer | null): DraggedThread[] {
  if (!data) return [];
  try {
    const parsed = JSON.parse(data.getData(THREAD_DRAG_TYPE) || "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is DraggedThread =>
        !!t && typeof t === "object" && typeof (t as DraggedThread).id === "string",
    );
  } catch {
    return [];
  }
}

/** Mentions waiting above the input, as the directives the sent turn carries. */
export function mentionDirectives(
  items: readonly { id: string; type: string; label: string }[],
): string {
  return items
    .map((i) =>
      unstable_defaultDirectiveFormatter.serialize({
        id: i.id,
        type: i.type,
        label: cleanLabel(i.label),
      }),
    )
    .join(" ");
}

/** Dropped Threads as the same directives an @ pick inserts, so the Agent reads them alike. */
export function threadDirectives(threads: readonly DraggedThread[], untitled: string): string {
  return threads
    .map((t) =>
      unstable_defaultDirectiveFormatter.serialize({
        id: t.id,
        type: "thread",
        label: cleanLabel(t.subject) || untitled,
      }),
    )
    .join(" ");
}

/** A label the directive syntax can carry: no brackets or braces, one line, not too long. */
export function cleanLabel(label: string): string {
  const one = label
    .replace(/[[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > 80 ? `${one.slice(0, 79)}…` : one;
}

export interface MentionSources {
  threads: readonly Thread[];
  groups: readonly Group[];
  sections: readonly { id: string; name: string }[];
  /** ai.composer.mention_threads: the newest Threads, and the people in them. */
  limit: number;
  /** The Workspace's own address, never offered as a person. */
  self?: string | undefined;
}

/** The mention list for a Workspace: the newest Threads and their people, every Group and Section. */
export function mentionItems({
  threads,
  groups,
  sections,
  limit,
  self,
}: MentionSources): MentionItem[] {
  const newest = [...threads]
    .filter((t) => !t.archived)
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
    .slice(0, Math.max(0, limit));
  const out: MentionItem[] = newest.map((t) => ({
    id: t.id,
    type: "thread",
    label: cleanLabel(t.subject) || t.id,
    description: t.participants[0]?.name || t.participants[0]?.email,
  }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const g of groups) {
    const parent = g.parentId ? byId.get(g.parentId) : undefined;
    out.push({
      id: g.id,
      type: "group",
      label: cleanLabel(parent ? `${parent.name} › ${g.name}` : g.name),
    });
  }
  for (const s of sections) out.push({ id: s.id, type: "section", label: cleanLabel(s.name) });
  const seen = new Set<string>(self ? [self.toLowerCase()] : []);
  for (const t of newest) {
    for (const p of t.participants) {
      const email = p.email.toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      out.push({
        id: p.email,
        type: "person",
        label: cleanLabel(p.name || p.email),
        description: p.email,
      });
    }
  }
  return out;
}

/**
 * A chip the screen attaches rather than an @ pick: `reply` is Draft a reply's
 * "reply to this Thread", which the user can add instructions to before sending.
 */
export type AttachKind = MentionKind | "reply";

export const MENTION_ICONS: Record<AttachKind, PhosphorIcon> = {
  reply: ArrowBendUpLeftIcon,
  thread: EnvelopeSimpleIcon,
  group: FolderSimpleIcon,
  section: RowsIcon,
  person: UserIcon,
};

const isKind = (type: string): type is AttachKind =>
  type === "reply" || (MENTION_KINDS as readonly string[]).includes(type);

/** A sent turn with its mentions as chips; a Thread chip opens the Thread. */
export function MentionText({ text }: { text: string }) {
  const { actions } = useComposerEnv();
  const segments = unstable_defaultDirectiveFormatter.parse(text);
  return (
    <>
      {segments.map((s, i) => {
        // Segments are positional and never reorder, so the index is their identity.
        const key = `${i}`;
        if (s.kind === "text") return <Fragment key={key}>{s.text}</Fragment>;
        if (!isKind(s.type)) return <Fragment key={key}>{s.label}</Fragment>;
        const chip = (
          <>
            <Icon icon={MENTION_ICONS[s.type]} />
            <span className="label">{s.label}</span>
          </>
        );
        return s.type === "thread" || s.type === "reply" ? (
          <button
            key={key}
            type="button"
            className="agent-mention"
            data-type={s.type}
            title={s.label}
            onClick={() => actions.openThread(s.id)}
          >
            {chip}
          </button>
        ) : (
          <span key={key} className="agent-mention" data-type={s.type} title={s.label}>
            {chip}
          </span>
        );
      })}
    </>
  );
}

/** A chip the screen puts above the composer's input, waiting for the user's words. */
export interface AttachRequest {
  id: string;
  type: AttachKind;
  label: string;
}

const attachListeners = new Set<(items: readonly AttachRequest[]) => void>();
let attachWaiting: AttachRequest[] = [];

/**
 * How a screen attaches a chip to whichever composer is mounted (the bar, or the
 * panel left or right): Draft a reply puts "Reply: Subject" there and the user
 * types how. With no composer mounted the chip waits for the next one.
 */
export const composerAttach = {
  attach(items: readonly AttachRequest[]): void {
    if (attachListeners.size === 0) {
      attachWaiting = [...attachWaiting, ...items];
      return;
    }
    for (const l of [...attachListeners]) l(items);
  },
  listen(listener: (items: readonly AttachRequest[]) => void): () => void {
    attachListeners.add(listener);
    if (attachWaiting.length) {
      const waiting = attachWaiting;
      attachWaiting = [];
      listener(waiting);
    }
    return () => {
      attachListeners.delete(listener);
    };
  },
};
