// The Signals page (docs/spec/signals.md, "The Signals page"; slice 32):
// Settings › AI and agent › Signals. One row per active Signal: its question
// in words, who uses it, its kind and version, how many Threads carry a
// current answer, how often it holds, and the stale count while a backfill
// runs; a shipped Signal's row opens its Setting, any other says where it is
// edited. Above it, the background read (slice 31): its progress, the
// confirm-above question with the count and estimate, a budget pause with its
// reason, and pause, resume or stop. Every word is a strings.signals.* Setting.

import type { SignalBackfill, SignalsPage } from "@monday/shared";
import { formatMicros } from "@monday/shared";
import { Btn } from "@monday/ui";
import { useCallback, useEffect, useState } from "react";
import { useShell } from "../../shell/Shell.tsx";
import { Card, messageOf, type PanelProps, registerPanel, useSettingsScreen } from "./render.tsx";
import { fill } from "./wizard.ts";

type Strings = ReturnType<typeof useShell>["settings"];

const group = (n: number) => n.toLocaleString("en-US");
const percent = (share: number) => `${Math.round(share * 100)}%`;

/** The background read in one line, with the words for why it waits. */
export function backfillLine(b: SignalBackfill, s: Strings): string {
  if (b.status === "confirm") {
    return fill(s["strings.signals.confirm_backfill"], {
      count: group(b.estimate?.threads ?? b.total),
      cost: formatMicros(b.estimate?.costMicros ?? 0),
    });
  }
  if (b.status === "waiting" && b.reason === "budget") {
    return fill(s["strings.signals.budget_paused"], {
      budget: formatMicros(b.budget?.budgetMicros ?? 0),
    });
  }
  if (b.status === "waiting" && b.reason === "no_judge")
    return s["strings.signals.waiting_no_judge"];
  return fill(s["strings.signals.reading"], {
    done: group(Math.min(b.done, b.total)),
    total: group(b.total),
  });
}

export function SignalsPanel(_: PanelProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const [page, setPage] = useState<SignalsPage | null | undefined>(undefined);
  const [backfill, setBackfill] = useState<SignalBackfill | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, b] = await Promise.all([
        shell.api.signals.page(screen.workspaceId),
        shell.api.signals.backfill(screen.workspaceId),
      ]);
      setPage(p);
      setBackfill(b);
      setError(null);
    } catch (e) {
      setPage(null);
      setError(`${s["strings.signals.page.unavailable"]} ${messageOf(e)}`);
    }
  }, [shell.api, screen.workspaceId, s]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: "confirm" | "pause" | "resume" | "cancel") => {
    try {
      setBackfill(await shell.api.signals.backfillAction(screen.workspaceId, action));
    } catch (e) {
      setError(messageOf(e));
    }
  };

  const running = backfill && !["done", "cancelled"].includes(backfill.status);
  return (
    <Card
      title={s["strings.signals.page.title"]}
      hint={s["strings.signals.page.intro"]}
      block
      attrs={{ "data-panel": "signals" }}
      foot={
        <>
          {running && backfill ? (
            <>
              <span data-backfill={backfill.status}>{backfillLine(backfill, s)}</span>
              <span className="sp" />
              {backfill.status === "confirm" ? (
                <Btn sm onClick={() => void act("confirm")}>
                  {s["strings.signals.read_now"]}
                </Btn>
              ) : null}
              {backfill.status === "waiting" && backfill.reason === "budget" ? (
                <Btn
                  sm
                  onClick={() => screen.navigate?.("ai", "signals.budget.background_monthly_usd")}
                >
                  {s["strings.signals.raise_budget"]}
                </Btn>
              ) : null}
              {backfill.status === "running" ? (
                <Btn sm onClick={() => void act("pause")}>
                  {s["strings.signals.pause"]}
                </Btn>
              ) : null}
              {backfill.status === "paused" ? (
                <Btn sm onClick={() => void act("resume")}>
                  {s["strings.signals.resume"]}
                </Btn>
              ) : null}
            </>
          ) : null}
          {error ? <span className="err">{error}</span> : null}
        </>
      }
    >
      {!page || page.signals.length === 0 ? (
        <div className="note">{page === undefined ? "" : s["strings.signals.page.empty"]}</div>
      ) : (
        <div className="matrix signals-table">
          {page.signals.map((row) => (
            <div className="mr" key={row.id} data-signal={row.id}>
              <div>
                {row.label}
                <span className="who">{row.consumers.join(", ")}</span>
                {row.flag === "too_broad" && row.holds !== null ? (
                  <span className="flag">
                    {fill(s["strings.signals.too_broad"], { share: percent(row.holds) })}
                  </span>
                ) : row.flag === "never" ? (
                  <span className="flag">{s["strings.signals.too_narrow"]}</span>
                ) : null}
              </div>
              <div>
                {s[`strings.signals.kind.${row.kind}`]}
                <span className="who">
                  {fill(s["strings.signals.page.version"], { version: row.version })}
                </span>
              </div>
              <div>
                {fill(s["strings.signals.page.read"], {
                  read: group(row.read),
                  total: group(page.total),
                })}
                {row.stale > 0 ? (
                  <span className="who">
                    {fill(s["strings.signals.page.stale"], { count: group(row.stale) })}
                  </span>
                ) : null}
              </div>
              <div>
                {row.holds !== null
                  ? fill(s["strings.signals.page.holds"], { share: percent(row.holds) })
                  : s["strings.signals.not_read"]}
                {row.setting ? (
                  <button
                    type="button"
                    className="link"
                    onClick={() => screen.navigate?.("ai", row.setting ?? undefined)}
                  >
                    {s["strings.signals.page.edit_setting"]}
                  </button>
                ) : (
                  <span className="who">
                    {fill(s["strings.signals.page.edit_owner"], {
                      owner: row.consumers[0] ?? row.owner.kind,
                    })}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

registerPanel("ai", "Signals", SignalsPanel, {
  title: "strings.signals.page.title",
  description: "strings.signals.page.intro",
  searchTerms: [
    "signals",
    "judgments",
    "questions",
    "backfill",
    "budget",
    "reading",
    "stale",
    "unsure",
  ],
});
