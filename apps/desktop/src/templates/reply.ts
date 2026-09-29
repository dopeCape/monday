// The on-open suggestion (docs/spec/templates.md, "On open"; actions.md): a
// Thread whose needs-reply holds asks the Server, once per Thread, which
// Template fits a reply with nothing typed yet, and the Reply chip is named
// with it ("Reply with Confirm the time"). Picking the named chip opens the
// reply with that Template inserted.

import type { Id } from "@monday/shared";
import { useEffect, useState } from "react";
import type { TemplateLink } from "./link.ts";

export interface ReplyTemplate {
  threadId: Id;
  templateId: Id;
  name: string;
}

export function useReplyTemplate(
  link: TemplateLink | null,
  threadId: Id | null,
  needsReply: number | null,
): ReplyTemplate | null {
  const [found, setFound] = useState<ReplyTemplate | null>(null);
  const on = Boolean(link?.enabled && link.onOpen.enabled);
  const threshold = link?.onOpen.needsReplyAt ?? 1;
  const ask = link?.onOpen.suggest;
  const wanted = on && threadId !== null && needsReply !== null && needsReply >= threshold;
  useEffect(() => {
    if (!wanted || !threadId || !ask) return;
    let live = true;
    void ask(threadId).then((r) => {
      if (!live) return;
      setFound(
        r?.status === "suggested" ? { threadId, templateId: r.templateId, name: r.name } : null,
      );
    });
    return () => {
      live = false;
    };
  }, [wanted, threadId, ask]);
  return found && found.threadId === threadId && wanted ? found : null;
}
