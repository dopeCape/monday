// The Agent's edits reach an open window: when update_draft changes the Draft
// the composer has open ("make this shorter" in the agent bar), the newer
// content arrives through the Composer's Drafts and replaces what the window
// shows, so the user sees the change where they are writing. Only a save by
// the Agent after the window opened counts; the user's own saves never loop
// back into the editor.

import type { DraftContent } from "@monday/shared";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Composer } from "./composer.ts";

export function useAgentEdits(
  composer: Composer,
  draftId: string,
  apply: (content: DraftContent) => void,
): void {
  const draft = useSyncExternalStore(
    composer.subscribe,
    () => composer.draft(draftId),
    () => composer.draft(draftId),
  );
  const seen = useRef(draft?.updatedAt ?? "");
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    if (!draft || draft.updatedBy !== "agent" || draft.updatedAt <= seen.current) return;
    seen.current = draft.updatedAt;
    let live = true;
    void composer.ensureContent(draftId).then((fresh) => {
      if (!live || !fresh) return;
      const {
        id: _i,
        workspaceId: _w,
        attachmentBlobIds: _b,
        status: _s,
        updatedAt: _u,
        updatedBy: _y,
        ...content
      } = fresh;
      applyRef.current(content);
    });
    return () => {
      live = false;
    };
  }, [draft, draftId, composer]);
}
