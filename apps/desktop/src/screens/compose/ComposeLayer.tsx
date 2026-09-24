// The compose surfaces that belong to the whole window, not to a screen: the
// full compose window, the send's Undo bar and compose's notices. The App
// renders them over whichever screen is open, so New message opens in place
// on the Calendar or Settings instead of leaving for the Inbox. (The dock of
// minimized windows renders itself through its own host; see useCompose.)

import { Toast } from "@monday/ui";
import { useExitValue } from "../inbox/useExit.ts";
import { ComposeOverlay } from "./ComposeOverlay.tsx";
import type { Composer } from "./composer.ts";
import { UndoBar } from "./UndoBar.tsx";
import type { ComposeController } from "./useCompose.ts";

export interface ComposeLayerProps {
  compose: ComposeController;
  composer: Composer;
  now: () => Date;
  /** Milliseconds a toast stays (inbox.undo_toast_ms). */
  toastMs: number;
  /** The Undo chord as the keymap shows it, for the bar's label. */
  undoKey: string;
  undoLabel: string;
  /** The Thread open behind, so an undone reply reopens in it. */
  openThreadId?: string | null | undefined;
}

export function ComposeLayer({
  compose,
  composer,
  now,
  toastMs,
  undoKey,
  undoLabel,
  openThreadId = null,
}: ComposeLayerProps) {
  const overlayExit = useExitValue(compose.overlay);
  const cs = compose.strings;
  return (
    <>
      {compose.pending ? (
        <UndoBar
          key={compose.pending.sendId}
          runAt={compose.pending.runAt}
          later={compose.pending.later}
          stayMs={toastMs}
          now={now}
          strings={cs.undo}
          undoKey={undoKey}
          onUndo={() => void compose.undo(openThreadId)}
          onElapsed={compose.elapsed}
        />
      ) : compose.notice ? (
        <Toast
          key={`n${compose.notice.id}`}
          text={compose.notice.text}
          undoLabel={undoLabel}
          undoKey={undoKey}
          ms={toastMs}
          onExpire={compose.clearNotice}
        />
      ) : null}
      {overlayExit.value ? (
        <ComposeOverlay
          key={overlayExit.value.draftId}
          composer={composer}
          draftId={overlayExit.value.draftId}
          initial={overlayExit.value.initial}
          strings={cs}
          idleMs={compose.idleMs}
          delaySeconds={compose.delaySeconds}
          laterPresetsHours={compose.laterPresetsHours}
          now={now}
          onClose={compose.closeOverlay}
          onSent={compose.onSent}
          onError={compose.onError}
          leaving={overlayExit.leaving}
          onLeft={overlayExit.onEnd}
        />
      ) : null}
    </>
  );
}
