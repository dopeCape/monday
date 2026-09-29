// The Approvals queue (docs/spec/workflows.md, "Approvals"): a sheet over any
// screen, opened from the nav, its shortcut or the palette, listing every
// approval waiting for the user with where it comes from, what it will do and
// which Thread it is about. Approve, Always allow this step and Decline go
// through the same routes as where the approval started (ADR 0002): a Run's
// POST /workflows/runs/:id/approvals, the Session's own approval stream. An
// item leaves as soon as it is answered; the queue closes on Escape or a
// click outside. Every word is a strings.approvals.* Setting.

import type { Settings } from "@monday/shared";
import { Btn, CheckBadges, formatWhen, Icon, RunApprovalCard, Scrim, ToolCard } from "@monday/ui";
import {
  ArrowSquareOutIcon,
  ChatCircleDotsIcon,
  EnvelopeSimpleIcon,
  FlowArrowIcon,
  PlugsIcon,
  SealCheckIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type BadgeSettings, previewBadges } from "../templates/badges.ts";
import type { ApprovalItem } from "./queue.ts";

export type ApprovalsSheetStrings = BadgeSettings &
  Pick<
    Settings,
    | "strings.approvals.title"
    | "strings.approvals.lede"
    | "strings.approvals.label"
    | "strings.approvals.empty"
    | "strings.approvals.empty_body"
    | "strings.approvals.close"
    | "strings.approvals.approve"
    | "strings.approvals.standing"
    | "strings.approvals.decline"
    | "strings.approvals.open_run"
    | "strings.approvals.open_thread"
    | "strings.approvals.open_session"
    | "strings.approvals.waiting_since"
    | "strings.approvals.failed"
    | "strings.approvals.approved"
    | "strings.approvals.declined"
  >;

export type Decision = "approved" | "declined";

export interface ApprovalsSheetProps {
  items: readonly ApprovalItem[];
  strings: ApprovalsSheetStrings;
  /** Answers one item; the sheet shows a failure and keeps the item when it throws. */
  onDecide: (item: ApprovalItem, decision: Decision, standing: boolean) => Promise<void>;
  onOpenRun?: ((item: Extract<ApprovalItem, { kind: "run" }>) => void) | undefined;
  onOpenThread?: ((threadId: string) => void) | undefined;
  /** Opens the agent on the item's Session (where an external caller's card waits). */
  onOpenSession?: ((item: ApprovalItem) => void) | undefined;
  onClose: () => void;
  now?: Date | undefined;
}

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

const KIND_ICON = {
  run: FlowArrowIcon,
  session: ChatCircleDotsIcon,
  external: PlugsIcon,
} as const;

export function ApprovalsSheet({
  items,
  strings: s,
  onDecide,
  onOpenRun,
  onOpenThread,
  onOpenSession,
  onClose,
  now,
}: ApprovalsSheetProps) {
  const panel = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  /** What was just answered, for the live region. */
  const [said, setSaid] = useState("");
  // The panel takes the focus, so Escape and Tab start inside it.
  useEffect(() => {
    panel.current?.focus();
  }, []);

  const decide = async (item: ApprovalItem, decision: Decision, standing: boolean) => {
    if (busy.has(item.key)) return;
    setBusy((b) => new Set(b).add(item.key));
    setError(null);
    try {
      await onDecide(item, decision, standing);
      setSaid(
        fill(
          s[decision === "approved" ? "strings.approvals.approved" : "strings.approvals.declined"],
          {
            what: item.what,
          },
        ),
      );
    } catch (e) {
      setError(
        fill(s["strings.approvals.failed"], {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(item.key);
        return next;
      });
    }
  };

  const card = (item: ApprovalItem): ReactNode => {
    const waiting = busy.has(item.key);
    if (item.kind === "external") {
      return <ToolCard call={item.call} icon={PlugsIcon} />;
    }
    if (item.kind === "run" && item.standing) {
      return (
        <RunApprovalCard
          call={item.call}
          preview={item.preview}
          approveLabel={s["strings.approvals.approve"]}
          standingLabel={s["strings.approvals.standing"]}
          declineLabel={s["strings.approvals.decline"]}
          onDecide={(decision, standing) => void decide(item, decision, standing)}
          busy={waiting}
          badges={previewBadges(item.preview, s)}
        />
      );
    }
    return (
      <ToolCard
        call={item.call}
        preview={
          item.preview?.kind === "text" ? (
            <pre className="appr-pre">{item.preview.text}</pre>
          ) : item.preview?.kind === "send" ? (
            <>
              <pre className="appr-pre">{`${item.preview.to.map((p) => p.email).join(", ")}: ${item.preview.subject}\n${item.preview.text}`}</pre>
              <CheckBadges badges={previewBadges(item.preview, s)} />
            </>
          ) : undefined
        }
        actions={[s["strings.approvals.approve"], s["strings.approvals.decline"]]}
        onAction={(action) => {
          if (waiting) return;
          void decide(
            item,
            action === s["strings.approvals.approve"] ? "approved" : "declined",
            false,
          );
        }}
      />
    );
  };

  return (
    <Scrim className="appr-scrim" onClose={onClose}>
      <section
        ref={panel}
        className="appr"
        role="dialog"
        aria-modal="true"
        aria-label={s["strings.approvals.label"]}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // The queue's own Escape: the screen under it keeps its state.
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
      >
        <header className="appr-head">
          <div className="appr-title">
            <h2>{s["strings.approvals.title"]}</h2>
            {items.length ? <span className="appr-n">{items.length}</span> : null}
            <Btn
              sm
              icon
              className="appr-close"
              aria-label={s["strings.approvals.close"]}
              title={s["strings.approvals.close"]}
              onClick={onClose}
            >
              <Icon icon={XIcon} />
            </Btn>
          </div>
          <p className="appr-lede">{s["strings.approvals.lede"]}</p>
        </header>
        {error ? (
          <p className="appr-error" role="alert">
            {error}
          </p>
        ) : null}
        {items.length === 0 ? (
          <div className="appr-empty">
            <Icon icon={SealCheckIcon} />
            <b>{s["strings.approvals.empty"]}</b>
            <p>{s["strings.approvals.empty_body"]}</p>
          </div>
        ) : (
          <ol className="appr-list">
            {items.map((item) => (
              <li
                key={item.key}
                className="appr-item"
                data-kind={item.kind}
                aria-busy={busy.has(item.key) ? "true" : undefined}
              >
                <div className="appr-from">
                  <Icon icon={KIND_ICON[item.kind]} />
                  <span className="appr-from-text">{item.from}</span>
                  {item.since ? (
                    <span className="appr-when">
                      {fill(s["strings.approvals.waiting_since"], {
                        when: formatWhen(item.since, now ?? new Date()),
                      })}
                    </span>
                  ) : null}
                </div>
                {card(item)}
                <div className="appr-links">
                  {item.about && item.threadId ? (
                    <button
                      type="button"
                      className="appr-link"
                      title={s["strings.approvals.open_thread"]}
                      onClick={() => item.threadId && onOpenThread?.(item.threadId)}
                    >
                      <Icon icon={EnvelopeSimpleIcon} />
                      <span>{item.about}</span>
                    </button>
                  ) : item.about ? (
                    <span className="appr-link static">
                      <Icon icon={EnvelopeSimpleIcon} />
                      <span>{item.about}</span>
                    </span>
                  ) : null}
                  {item.kind === "run" && onOpenRun ? (
                    <button type="button" className="appr-link" onClick={() => onOpenRun(item)}>
                      <Icon icon={ArrowSquareOutIcon} />
                      <span>{s["strings.approvals.open_run"]}</span>
                    </button>
                  ) : null}
                  {item.kind !== "run" && onOpenSession ? (
                    <button type="button" className="appr-link" onClick={() => onOpenSession(item)}>
                      <Icon icon={ArrowSquareOutIcon} />
                      <span>{s["strings.approvals.open_session"]}</span>
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
        <p className="appr-said" role="status" aria-live="polite">
          {said}
        </p>
      </section>
    </Scrim>
  );
}
