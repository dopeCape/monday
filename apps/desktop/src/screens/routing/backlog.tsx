// The Sort scope and the Backlog sort on the client (CONTEXT.md "Sort
// scope", "Backlog sort"; docs/spec/routing.md): the scope picker the
// Re-run popover and onboarding's scope step share, the hook that follows
// the Workspace's Backlog sort while it runs, its card on the Routing page
// (progress, pause, resume, stop), and the one line the agent's card and
// onboarding's conversation show. Every word is a Setting
// (strings.routing.scope.*, strings.routing.backlog.*, strings.agent.backlog.*).

import type { RoutingBacklog, ScopeUnit, Settings, SortScope, SortScopeKind } from "@monday/shared";
import { describeSortScope, formatSortScope, parseSortScope, scopeWordsFrom } from "@monday/shared";
import { Btn, cx, Icon, Seg } from "@monday/ui";
import { ArrowsClockwiseIcon, PauseIcon, PlayIcon, StopIcon, XIcon } from "@phosphor-icons/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { fill } from "../inbox/triage.ts";

/* ------------------------------ Words ------------------------------ */

const group = (n: number) => n.toLocaleString();
const dateOf = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/** A scope sentence in the user's words; the sentence itself when it does not parse. */
export function scopeWords(text: string, settings: Settings): string {
  const scope = parseSortScope(text);
  if (!scope) return text;
  return describeSortScope(scope, scopeWordsFrom(settings), { date: dateOf, group });
}

/** The first letter up, for a scope that starts a sentence. */
export const capitalized = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s);

/* ------------------------------ The picker ------------------------------ */

interface Draft {
  kind: SortScopeKind;
  count: string;
  amount: string;
  unit: ScopeUnit;
  date: string;
}

function draftOf(text: string): Draft {
  const scope = parseSortScope(text);
  const base: Draft = { kind: "latest", count: "50", amount: "3", unit: "months", date: "" };
  if (!scope) return base;
  if (scope.kind === "latest") return { ...base, kind: "latest", count: String(scope.count) };
  if (scope.kind === "last") {
    return { ...base, kind: "last", amount: String(scope.amount), unit: scope.unit };
  }
  if (scope.kind === "since") return { ...base, kind: "since", date: scope.date };
  return { ...base, kind: "all" };
}

function scopeOfDraft(d: Draft): SortScope | null {
  const whole = (v: string) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? n : null;
  };
  if (d.kind === "latest") {
    const n = whole(d.count);
    return n === null ? null : { kind: "latest", count: n };
  }
  if (d.kind === "last") {
    const n = whole(d.amount);
    return n === null ? null : { kind: "last", amount: n, unit: d.unit };
  }
  if (d.kind === "since") return parseSortScope(`since ${d.date}`);
  return { kind: "all" };
}

export interface ScopePickerProps {
  /** The scope as a sentence ("latest 50", "last 3 months", "since 2026-01-01", "all"). */
  value: string;
  /** Called with the canonical sentence whenever the pick is a scope; null while it is not one. */
  onChange: (value: string | null) => void;
  settings: Settings;
  className?: string | undefined;
}

/**
 * How much mail to sort: the newest N threads, the last N days, weeks,
 * months or years, everything since a date, or everything. monday's own
 * segmented controls, never a native select; the line under it says the
 * pick back in words.
 */
export function ScopePicker({ value, onChange, settings, className }: ScopePickerProps) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(value));
  const scope = scopeOfDraft(draft);
  const change = (next: Draft) => {
    setDraft(next);
    const s = scopeOfDraft(next);
    onChange(s ? formatSortScope(s) : null);
  };
  const s = settings;
  return (
    <div className={cx("scope-pick", className)} data-kind={draft.kind}>
      <Seg<SortScopeKind>
        className="scope-kinds"
        options={[
          { value: "latest", label: s["strings.routing.scope.kind.latest"] },
          { value: "last", label: s["strings.routing.scope.kind.last"] },
          { value: "since", label: s["strings.routing.scope.kind.since"] },
          { value: "all", label: s["strings.routing.scope.kind.all"] },
        ]}
        value={draft.kind}
        onChange={(kind) => change({ ...draft, kind })}
      />
      {draft.kind === "latest" ? (
        <div className="scope-row">
          <input
            className="input scope-n"
            type="number"
            min={1}
            inputMode="numeric"
            aria-label={s["strings.routing.scope.kind.latest"]}
            value={draft.count}
            onChange={(e) => change({ ...draft, count: e.currentTarget.value })}
          />
          <span>{s["strings.routing.scope.threads"]}</span>
        </div>
      ) : null}
      {draft.kind === "last" ? (
        <div className="scope-row">
          <input
            className="input scope-n"
            type="number"
            min={1}
            inputMode="numeric"
            aria-label={s["strings.routing.scope.kind.last"]}
            value={draft.amount}
            onChange={(e) => change({ ...draft, amount: e.currentTarget.value })}
          />
          <Seg<ScopeUnit>
            className="scope-units"
            options={(["days", "weeks", "months", "years"] as const).map((u) => ({
              value: u,
              label: s[`strings.routing.scope.unit.${u}`],
            }))}
            value={draft.unit}
            onChange={(unit) => change({ ...draft, unit })}
          />
        </div>
      ) : null}
      {draft.kind === "since" ? (
        <div className="scope-row">
          <input
            className="input scope-date"
            type="date"
            aria-label={s["strings.routing.scope.kind.since"]}
            value={draft.date}
            onChange={(e) => change({ ...draft, date: e.currentTarget.value })}
          />
        </div>
      ) : null}
      <p className="faint scope-says" aria-live="polite">
        {scope
          ? capitalized(describeSortScope(scope, scopeWordsFrom(s), { date: dateOf, group }))
          : s["strings.routing.scope.invalid"]}
      </p>
    </div>
  );
}

/* ------------------------------ Following a Backlog sort ------------------------------ */

/** What reads the Workspace's Backlog sort: the routing API, a fake in tests. */
export interface BacklogSource {
  backlog(workspaceId: string): Promise<RoutingBacklog | null>;
}

/** The Backlog sort the agent's card and onboarding follow, when the screen provides one. */
export const BacklogContext = createContext<{
  workspaceId: string;
  source: BacklogSource;
  pollSeconds: number;
  /** The words a card says it with. */
  settings: Settings;
} | null>(null);

const live = (b: RoutingBacklog | null) =>
  b !== null && (b.status === "running" || b.status === "waiting");

/**
 * The Workspace's Backlog sort, read once and then every `pollSeconds`
 * while it runs or waits. `set` puts a fresher answer in (the one a Pause or
 * a start returned), `refresh` reads again now.
 */
export function useBacklog(
  source: BacklogSource | null | undefined,
  workspaceId: string,
  pollSeconds: number,
  enabled = true,
) {
  const [backlog, setBacklog] = useState<RoutingBacklog | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick asks for a fresh read.
  useEffect(() => {
    if (!source || !enabled) return;
    let on = true;
    source
      .backlog(workspaceId)
      .then((b) => {
        if (on) setBacklog(b);
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [source, workspaceId, enabled, tick]);
  const running = live(backlog);
  useEffect(() => {
    if (!running || !enabled) return;
    const id = setInterval(refresh, Math.max(1, pollSeconds) * 1000);
    return () => clearInterval(id);
  }, [running, enabled, pollSeconds, refresh]);
  return { backlog, set: setBacklog, refresh };
}

/** The Backlog sort the context names, followed while the component is on screen, with its words. */
export function useBacklogFromContext(enabled = true): {
  backlog: RoutingBacklog | null;
  settings: Settings | null;
} {
  const ctx = useContext(BacklogContext);
  const { backlog } = useBacklog(
    ctx?.source ?? null,
    ctx?.workspaceId ?? "",
    ctx?.pollSeconds ?? 3,
    enabled && ctx !== null,
  );
  return { backlog, settings: ctx?.settings ?? null };
}

/* ------------------------------ The card and the line ------------------------------ */

/** Why it waits, in the Settings' words. */
export function waitingWords(b: RoutingBacklog, s: Settings): string {
  if (b.reason === "sync") return s["strings.routing.backlog.sync"];
  if (b.reason === "level") return s["strings.routing.backlog.level"];
  if (b.reason === "budget") {
    const budget = `$${s["signals.budget.background_monthly_usd"].toFixed(2)}`;
    return s["strings.signals.budget_paused"].replaceAll("{budget}", budget);
  }
  return s["strings.routing.hosted_needed"];
}

/** One line for the agent's card and onboarding: how far it got, or how it ended. */
export function backlogLine(b: RoutingBacklog, s: Settings): string {
  const scope = scopeWords(b.scope, s);
  const vars = {
    scope,
    done: group(Math.min(b.done, b.total)),
    total: group(b.total),
    moved: group(b.moved),
    asked: group(b.asked),
  };
  if (b.status === "done") return fill(s["strings.agent.backlog.finished"], vars);
  if (b.status === "cancelled") return fill(s["strings.routing.backlog.cancelled"], vars);
  if (b.status === "waiting") {
    return fill(s["strings.agent.backlog.waiting"], { reason: waitingWords(b, s) });
  }
  if (b.status === "paused") {
    return `${fill(s["strings.agent.backlog.running"], vars)} (${s["strings.routing.backlog.paused"]})`;
  }
  return fill(s["strings.agent.backlog.running"], vars);
}

export interface BacklogCardProps {
  backlog: RoutingBacklog;
  settings: Settings;
  busy?: boolean | undefined;
  onAction: (action: "pause" | "resume" | "cancel") => void;
  onDismiss?: (() => void) | undefined;
}

/** The Backlog sort on the Routing page: how far, what it did, why it waits, and its three buttons. */
export function BacklogCard({
  backlog: b,
  settings: s,
  busy,
  onAction,
  onDismiss,
}: BacklogCardProps) {
  const scope = scopeWords(b.scope, s);
  const total = Math.max(b.total, b.done);
  const share = total > 0 ? Math.min(1, b.done / total) : 0;
  const finished = b.status === "done" || b.status === "cancelled";
  const vars = {
    scope,
    done: group(Math.min(b.done, total)),
    total: group(total),
    moved: group(b.moved),
    asked: group(b.asked),
    skipped: group(b.skipped),
  };
  const heading = finished
    ? fill(
        b.status === "done"
          ? s["strings.routing.backlog.done"]
          : s["strings.routing.backlog.cancelled"],
        vars,
      )
    : fill(s["strings.routing.backlog.title"], vars);
  return (
    <div
      className="rt-rerun rt-backlog"
      role="status"
      aria-live="polite"
      data-status={b.status}
      data-reason={b.reason ?? undefined}
    >
      <div className="rt-rerun-head">
        <Icon
          icon={ArrowsClockwiseIcon}
          className={cx(b.status === "running" && "rt-rerun-spin")}
        />
        <b>{heading}</b>
        {finished ? null : (
          <span className="faint">{fill(s["strings.routing.backlog.progress"], vars)}</span>
        )}
        <span className="sp" />
        {b.status === "running" || b.status === "waiting" ? (
          <Btn sm onClick={() => onAction("pause")} disabled={busy}>
            <Icon icon={PauseIcon} /> {s["strings.routing.backlog.pause"]}
          </Btn>
        ) : null}
        {b.status === "paused" ? (
          <Btn sm onClick={() => onAction("resume")} disabled={busy}>
            <Icon icon={PlayIcon} /> {s["strings.routing.backlog.resume"]}
          </Btn>
        ) : null}
        {finished ? null : (
          <Btn sm onClick={() => onAction("cancel")} disabled={busy}>
            <Icon icon={StopIcon} /> {s["strings.routing.backlog.cancel"]}
          </Btn>
        )}
        {finished && onDismiss ? (
          <Btn sm onClick={onDismiss} aria-label={s["strings.routing.backlog.dismiss"]}>
            <Icon icon={XIcon} /> {s["strings.routing.backlog.dismiss"]}
          </Btn>
        ) : null}
      </div>
      {finished ? null : (
        <div className="rt-rerun-bar" aria-hidden="true">
          <span style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
      )}
      <p className="faint rt-rerun-now">
        {fill(s["strings.routing.backlog.counts"], vars)}
        {b.batches > 0 && !finished
          ? ` · ${fill(s["strings.routing.backlog.batch"], { n: group(b.batches), size: b.batchSize })}`
          : ""}
      </p>
      {b.status === "paused" ? (
        <p className="faint rt-backlog-note">{s["strings.routing.backlog.paused"]}</p>
      ) : null}
      {b.status === "waiting" ? (
        <p className="faint rt-backlog-note">{waitingWords(b, s)}</p>
      ) : null}
      {b.sorter === "llm" && b.local && !finished ? (
        <p className="faint rt-backlog-note">{s["strings.routing.backlog.slow"]}</p>
      ) : null}
      {b.lastError && !finished ? (
        <p className="faint rt-backlog-note">
          {fill(s["strings.routing.backlog.error"], { message: b.lastError })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Whether a Backlog sort is worth showing: under way or paused; once it
 * ends, only if this screen saw it under way, until dismissed. A run that
 * finished before the page opened stays out of the way.
 */
export function useBacklogShown(b: RoutingBacklog | null) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [seen, setSeen] = useState<string | null>(null);
  const run = b?.startedAt ?? null;
  const going = b !== null && (live(b) || b.status === "paused");
  useEffect(() => {
    if (going && run) setSeen(run);
  }, [going, run]);
  const shown = useMemo(
    () => b !== null && dismissed !== run && (going || seen === run),
    [b, dismissed, run, going, seen],
  );
  return { shown, dismiss: () => setDismissed(run) };
}
