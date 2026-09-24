// An Account whose calendar cannot be read, said plainly under the header:
// what is wrong, the fix (enable the Google Calendar API in the Cloud
// project, sign in again and allow the calendar, reconnect), a button that
// goes there, "Try again", and the Provider's own words folded away.

import type { CalendarProblemKind, CalendarStatus, Settings } from "@monday/shared";
import { Btn, Icon } from "@monday/ui";
import { ArrowSquareOutIcon, WarningIcon } from "@phosphor-icons/react";
import { useState } from "react";

const fill = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

type ProblemCopy = { title: string; body: string };

function copyFor(
  kind: CalendarProblemKind,
  source: CalendarStatus["source"],
  s: Settings,
): ProblemCopy {
  const google = source === "google";
  switch (kind) {
    case "api-disabled":
      return google
        ? {
            title: s["strings.calendar.problem.api_disabled.title"],
            body: s["strings.calendar.problem.api_disabled.google"],
          }
        : {
            title: s["strings.calendar.problem.api_disabled.title"],
            body: s["strings.calendar.problem.api_disabled.other"],
          };
    case "scope":
      return {
        title: s["strings.calendar.problem.scope.title"],
        body: s["strings.calendar.problem.scope.body"],
      };
    case "auth":
      return {
        title: s["strings.calendar.problem.auth.title"],
        body: s["strings.calendar.problem.auth.body"],
      };
    case "network":
      return {
        title: s["strings.calendar.problem.network.title"],
        body: s["strings.calendar.problem.network.body"],
      };
    case "rate-limit":
      return {
        title: s["strings.calendar.problem.rate_limit.title"],
        body: s["strings.calendar.problem.rate_limit.body"],
      };
    default:
      return {
        title: s["strings.calendar.problem.other.title"],
        body: s["strings.calendar.problem.other.body"],
      };
  }
}

export interface StatusBannerProps {
  status: CalendarStatus;
  address: string;
  s: Settings;
  onOpen: (url: string) => void;
  onRetry: () => Promise<void>;
  onReconnect: () => void;
}

export function StatusBanner({
  status,
  address,
  s,
  onOpen,
  onRetry,
  onReconnect,
}: StatusBannerProps) {
  const [trying, setTrying] = useState(false);
  const problem = status.problem;
  if (!problem) return null;
  const copy = copyFor(problem.kind, status.source, s);
  const retry = () => {
    setTrying(true);
    void onRetry().finally(() => setTrying(false));
  };
  return (
    <div className="cal-banner" role="alert" data-kind={problem.kind}>
      <Icon icon={WarningIcon} />
      <div className="cal-banner-text">
        <b>{fill(copy.title, { account: address })}</b>
        <p>{fill(copy.body, { account: address })}</p>
        {problem.message ? (
          <details>
            <summary>{s["strings.calendar.problem.details"]}</summary>
            <code>{problem.message}</code>
          </details>
        ) : null}
      </div>
      <div className="cal-banner-actions">
        {problem.kind === "api-disabled" && problem.fixUrl ? (
          <Btn primary onClick={() => onOpen(problem.fixUrl as string)}>
            <Icon icon={ArrowSquareOutIcon} />{" "}
            {status.source === "google"
              ? s["strings.accounts.google.calendar_api_action"]
              : s["strings.calendar.problem.open_fix"]}
          </Btn>
        ) : null}
        {problem.kind === "scope" || problem.kind === "auth" ? (
          <Btn primary onClick={onReconnect}>
            {s["strings.calendar.problem.reconnect"]}
          </Btn>
        ) : null}
        <Btn onClick={retry} disabled={trying}>
          {trying ? s["strings.calendar.problem.trying"] : s["strings.calendar.problem.retry"]}
        </Btn>
      </div>
    </div>
  );
}
