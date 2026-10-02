// What a compose surface needs from Templates, keyed by its Composer like the
// compose link (screens/compose/link.ts): the library, the Settings the
// picker and the chips read, the strings, and the Server calls that fill
// Placeholders. The Bridge (Bridge.tsx) sets it where the Shell and the Store
// are at hand; a surface rendered on its own in a test finds none and offers
// no Templates.

import type {
  Id,
  Person,
  Template,
  TemplateFillResult,
  TemplateRank,
  TemplateSuggestResult,
} from "@monday/shared";
import { useSyncExternalStore } from "react";
import type { Composer } from "../screens/compose/composer.ts";
import type { TemplateUiStrings } from "./strings.ts";

export interface TemplateLink {
  enabled: boolean;
  /** Typed at a line start, opens the picker (templates.trigger). */
  trigger: string;
  /** The chord that opens the picker (compose.templates.open). */
  openKey: string;
  library: readonly Template[];
  strings: TemplateUiStrings;
  /** Fills a Template's Placeholders from the Thread (or the To name); null when the Server cannot. */
  fill(
    templateId: Id,
    from: { threadId: Id | null; to: Person[] },
  ): Promise<TemplateFillResult | null>;
  /** Suggestions while typing (templates.suggest.*); off when `enabled` is false. */
  suggestion: {
    enabled: boolean;
    debounceMs: number;
    minIntervalMs: number;
    maxTypedChars: number;
  };
  /**
   * The two requests; null when the Server could not be asked. `rankOnly` asks the quick
   * ranking alone; `prior` hands that answer back so only the closer look runs.
   */
  suggest(request: {
    threadId: Id | null;
    draft: { to: Person[]; subject: string; typed: string };
    rankOnly?: boolean | undefined;
    prior?: { ranking: TemplateRank[]; gate: number } | undefined;
  }): Promise<TemplateSuggestResult | null>;
  /** "Save as template" and "Make a template from this": opens the sheet that writes one. */
  draftFrom(source: TemplateDraftSource): void;
  /** On open: the Template that names the Reply chip, when a needs-reply Thread has one (templates.suggest.on_open). */
  onOpen: {
    enabled: boolean;
    needsReplyAt: number;
    suggest(threadId: Id): Promise<TemplateSuggestResult | null>;
  };
  /**
   * Jev's order for the picker (templates.picker.*): request 1's ranking for a
   * Thread and what was typed, remembered briefly; off when `enabled` is false.
   */
  ranking: {
    enabled: boolean;
    /** The most Templates marked Suggested, and the least share that marks one. */
    suggestedMax: number;
    suggestedFloor: number;
    /** Null when the Server could not be asked or gave no ranking. */
    rank(request: {
      threadId: Id | null;
      draft: { to: Person[]; subject: string; typed: string };
    }): Promise<TemplateRank[] | null>;
  };
  /** The one-time "Type ;; for templates" line (templates.hint.trigger_seen on this device). */
  hint: { show: boolean; dismiss(): void };
  /** Opens Settings › Templates; absent where there is no Settings to open. */
  manage?: (() => void) | undefined;
}

/** Where a Template is written from: sent Messages, or a Draft's text. */
export type TemplateDraftSource =
  | { messageIds: Id[] }
  | { texts: Array<{ subject: string; text: string }> };

interface LinkBox {
  value: TemplateLink | null;
  listeners: Set<() => void>;
  /** A Template picked from the palette for the next surface that opens. */
  queued: Id | null;
}

const boxes = new WeakMap<Composer, LinkBox>();

function boxOf(composer: Composer): LinkBox {
  let box = boxes.get(composer);
  if (!box) {
    box = { value: null, listeners: new Set(), queued: null };
    boxes.set(composer, box);
  }
  return box;
}

/** The palette's "Template: …": the next compose surface to open inserts it. */
export function queueTemplate(composer: Composer, templateId: Id | null): void {
  boxOf(composer).queued = templateId;
}

/** Takes the queued Template, once. */
export function takeQueuedTemplate(composer: Composer): Id | null {
  const box = boxOf(composer);
  const id = box.queued;
  box.queued = null;
  return id;
}

export function setTemplateLink(composer: Composer, link: TemplateLink | null): void {
  const box = boxOf(composer);
  box.value = link;
  for (const l of [...box.listeners]) l();
}

export function templateLinkOf(composer: Composer): TemplateLink | null {
  return boxes.get(composer)?.value ?? null;
}

/** The link for a surface, re-rendering when the library or the Settings change. */
export function useTemplateLink(composer: Composer): TemplateLink | null {
  const box = boxOf(composer);
  return useSyncExternalStore(
    (listener) => {
      box.listeners.add(listener);
      return () => box.listeners.delete(listener);
    },
    () => box.value,
    () => box.value,
  );
}
