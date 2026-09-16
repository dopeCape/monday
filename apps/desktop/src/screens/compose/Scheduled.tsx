// The Scheduled view: every send still waiting for its run time, with the
// Draft's subject and recipients and a Cancel that reopens the Draft
// (ADR 0010: send later and undo send are one mechanism).

import { Btn, ColHead, formatWhen } from "@monday/ui";
import { useSyncExternalStore } from "react";
import type { Composer } from "./composer.ts";
import type { ComposeUiStrings } from "./strings.ts";

export interface ScheduledProps {
  composer: Composer;
  strings: ComposeUiStrings["scheduled"];
  now: Date;
  onCancel?: ((sendId: string) => void) | undefined;
}

export function Scheduled({ composer, strings, now, onCancel }: ScheduledProps) {
  const sends = useSyncExternalStore(composer.subscribe, composer.sends, composer.sends);
  const pending = sends.filter((s) => s.status === "scheduled");
  return (
    <section className="col list scheduled" aria-label={strings.title}>
      <ColHead title={strings.title} count={pending.length} />
      <div className="col-body">
        {pending.length === 0 ? <div className="empty-line">{strings.empty}</div> : null}
        {pending.map((send) => {
          const draft = composer.draft(send.draftId);
          const to = [...(draft?.to ?? []), ...(draft?.cc ?? [])]
            .map((p) => p.name || p.email)
            .join(", ");
          return (
            <div key={send.id} className="scheduled-row" data-send={send.id}>
              <div>
                <div>{draft?.subject || strings.noSubject}</div>
                <div className="to">{strings.to.replace("{to}", to)}</div>
              </div>
              <span className="when">{formatWhen(send.runAt, now)}</span>
              <Btn
                sm
                onClick={() => {
                  void composer.cancel(send.id);
                  onCancel?.(send.id);
                }}
              >
                {strings.cancel}
              </Btn>
            </div>
          );
        })}
      </div>
    </section>
  );
}
