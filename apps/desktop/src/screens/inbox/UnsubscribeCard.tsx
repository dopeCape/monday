// The unsubscribe card (docs/spec/actions.md, Unsubscribe): leaving a list
// reaches a third party, so it asks first (ADR 0002), naming the list and the
// exact request: the RFC 8058 one-click POST and its URL, or the address the
// unsubscribe email goes to. Approving sends exactly that through the
// unsubscribe tool; afterwards it offers to archive the list's issues.

import type { Recommendation } from "@monday/shared";
import { Btn } from "@monday/ui";
import type { ListExit } from "../../platform/api.ts";
import { fill } from "./triage.ts";

export interface UnsubscribeCardState {
  threadId: string;
  rec: Extract<Recommendation, { kind: "unsubscribe" }>;
  /** The exact request, read again from the Server when the card opens; null while it loads. */
  exit: ListExit | null;
  status: "asking" | "running" | "done" | "failed";
  text?: string | undefined;
}

export interface UnsubscribeCardStrings {
  title: string;
  post: string;
  mail: string;
  approve: string;
  cancel: string;
  archiveIssues: string;
}

export function UnsubscribeCard({
  card,
  strings,
  onAnswer,
  onArchiveIssues,
}: {
  card: UnsubscribeCardState;
  strings: UnsubscribeCardStrings;
  onAnswer: (approve: boolean) => void;
  onArchiveIssues: () => void;
}) {
  const exit = card.exit;
  const list = exit?.listName ?? card.rec.listName;
  const line = exit
    ? fill(exit.method === "one_click" ? strings.post : strings.mail, { target: exit.target })
    : "";
  return (
    <div className="chip-card" data-card="unsubscribe" data-status={card.status}>
      <b>{fill(strings.title, { list })}</b>
      {line ? <span data-request={exit?.method}>{line}</span> : null}
      {card.text ? <span className="note">{card.text}</span> : null}
      <div className="chip-card-foot">
        {card.status === "done" && (exit?.issues ?? 0) > 0 ? (
          <Btn sm onClick={onArchiveIssues}>
            {fill(strings.archiveIssues, { count: exit?.issues ?? 0 })}
          </Btn>
        ) : null}
        {card.status === "asking" || card.status === "running" ? (
          <>
            <Btn sm onClick={() => onAnswer(false)}>
              {strings.cancel}
            </Btn>
            <Btn
              sm
              primary
              disabled={!exit || card.status === "running"}
              data-approve="unsubscribe"
              onClick={() => onAnswer(true)}
            >
              {strings.approve}
            </Btn>
          </>
        ) : (
          <Btn sm onClick={() => onAnswer(false)}>
            {strings.cancel}
          </Btn>
        )}
      </div>
    </div>
  );
}
