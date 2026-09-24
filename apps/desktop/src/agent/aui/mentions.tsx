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

export const MENTION_ICONS: Record<MentionKind, PhosphorIcon> = {
  thread: EnvelopeSimpleIcon,
  group: FolderSimpleIcon,
  section: RowsIcon,
  person: UserIcon,
};

const isKind = (type: string): type is MentionKind =>
  (MENTION_KINDS as readonly string[]).includes(type);

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
            {s.label}
          </>
        );
        return s.type === "thread" ? (
          <button
            key={key}
            type="button"
            className="agent-mention"
            data-type={s.type}
            onClick={() => actions.openThread(s.id)}
          >
            {chip}
          </button>
        ) : (
          <span key={key} className="agent-mention" data-type={s.type}>
            {chip}
          </span>
        );
      })}
    </>
  );
}
