// What a compose surface needs from Templates, keyed by its Composer like the
// compose link (screens/compose/link.ts): the library, the Settings the
// picker and the chips read, the strings, and the Server calls that fill
// Placeholders. The Bridge (Bridge.tsx) sets it where the Shell and the Store
// are at hand; a surface rendered on its own in a test finds none and offers
// no Templates.

import type { Id, Person, Template, TemplateFillResult } from "@monday/shared";
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
}

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
