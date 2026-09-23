// The first sync screen's arithmetic over the Server's readings: a bar that
// never goes backwards (totals grow as the Provider pages, and the share may
// dip; the screen keeps the highest it showed), a time remaining from the
// recent rate shown only once the estimates agree, and the lines each phase
// reads. Pure; the screen holds one Tracker per Account across remounts.

import {
  type FirstRunWait,
  type FirstSyncCount,
  type FirstSyncProgress,
  firstSyncFraction,
  firstSyncPhase,
  type Settings,
} from "@monday/shared";

export interface Sample {
  /** Client clock, milliseconds. */
  at: number;
  fraction: number;
}

export interface Tracker {
  /** The highest share shown so far; the bar never draws less. */
  shown: number;
  /** Per phase, the highest count shown so far. */
  counts: { headers: number; bodies: number };
  /** Per phase, the highest share of its own bar shown so far. */
  lines: { headers: number; bodies: number };
  samples: Sample[];
  /** The last few estimates, milliseconds, for the steadiness check. */
  estimates: number[];
}

export function emptyTracker(): Tracker {
  return {
    shown: 0,
    counts: { headers: 0, bodies: 0 },
    lines: { headers: 0, bodies: 0 },
    samples: [],
    estimates: [],
  };
}

export interface EtaSettings {
  windowMs: number;
  minSamples: number;
  tolerance: number;
}

export function etaSettings(s: Settings): EtaSettings {
  return {
    windowMs: s["sync.first_run_eta_window_seconds"] * 1000,
    minSamples: s["sync.first_run_eta_min_samples"],
    tolerance: s["sync.first_run_eta_tolerance"],
  };
}

/** How many estimates must agree before the time remaining shows. */
const STEADY_ESTIMATES = 3;

/** Folds a reading into the tracker. Never lowers `shown` or a count. */
export function track(
  prev: Tracker,
  progress: FirstSyncProgress,
  wait: FirstRunWait,
  at: number,
  eta: EtaSettings,
): Tracker {
  const fraction = Math.max(prev.shown, firstSyncFraction(progress, wait));
  const samples = [...prev.samples, { at, fraction }].filter((s) => at - s.at <= eta.windowMs);
  const estimate = remainingMs(samples);
  const estimates = estimate === null ? [] : [...prev.estimates, estimate].slice(-STEADY_ESTIMATES);
  const counts = {
    headers: Math.max(prev.counts.headers, progress.headers.done),
    bodies: Math.max(prev.counts.bodies, progress.bodies.done),
  };
  return {
    shown: fraction,
    counts,
    lines: {
      headers: Math.max(prev.lines.headers, lineFraction(progress.headers, counts.headers) ?? 0),
      bodies: Math.max(prev.lines.bodies, lineFraction(progress.bodies, counts.bodies) ?? 0),
    },
    samples,
    estimates,
  };
}

/** Milliseconds left at the rate across the samples; null without movement. */
export function remainingMs(samples: readonly Sample[]): number | null {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last || last.at <= first.at) return null;
  const rate = (last.fraction - first.fraction) / (last.at - first.at);
  if (rate <= 0) return null;
  return (1 - last.fraction) / rate;
}

/** The time remaining to show, or null while it is not yet steady. */
export function steadyEta(tracker: Tracker, eta: EtaSettings): number | null {
  if (tracker.samples.length < eta.minSamples) return null;
  if (tracker.estimates.length < STEADY_ESTIMATES) return null;
  const lo = Math.min(...tracker.estimates);
  const hi = Math.max(...tracker.estimates);
  if (lo <= 0 || hi / lo - 1 > eta.tolerance) return null;
  return tracker.estimates[tracker.estimates.length - 1] ?? null;
}

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) =>
    values[k] === undefined ? m : String(values[k]),
  );
}

const number = new Intl.NumberFormat("en-US");

export function formatCount(n: number): string {
  return number.format(n);
}

/** "Less than a minute left", "About 4 minutes left", "About 2 hours left". */
export function formatEta(ms: number, s: Settings): string {
  const minutes = ms / 60_000;
  if (minutes < 1.5) return s["strings.first_sync.eta_under_minute"];
  if (minutes < 90) return fill(s["strings.first_sync.eta_minutes"], { n: Math.round(minutes) });
  return fill(s["strings.first_sync.eta_hours"], { n: Math.round(minutes / 60) });
}

export type LineState = "active" | "waiting" | "done";

export interface PhaseLine {
  phase: "headers" | "bodies";
  label: string;
  /** "1,204 of 12,418", "1,204 found", "Next" or "Done". */
  detail: string;
  /** 0 to 1, never less than shown before; null when the total is unknown. */
  fraction: number | null;
  state: LineState;
}

/** A phase's own share: 1 once complete, null while the total is unknown. */
function lineFraction(c: FirstSyncCount, highest: number): number | null {
  if (c.complete) return 1;
  if (c.total === null) return null;
  const done = Math.max(highest, c.done);
  const total = Math.max(c.total, done);
  return total > 0 ? done / total : 0;
}

function countLine(
  c: FirstSyncCount,
  highest: number,
  shown: number,
  s: Settings,
): { detail: string; fraction: number | null } {
  const done = Math.max(highest, c.done);
  const own = lineFraction(c, highest);
  const fraction = own === null ? null : Math.max(shown, own);
  if (c.complete) return { detail: s["strings.first_sync.phase_done"], fraction };
  if (c.total === null) {
    return {
      detail: fill(s["strings.first_sync.count_unknown"], { done: formatCount(done) }),
      fraction,
    };
  }
  return {
    detail: fill(s["strings.first_sync.count"], {
      done: formatCount(done),
      total: formatCount(Math.max(c.total, done)),
    }),
    fraction,
  };
}

/** One line per phase the Setting waits for. */
export function phaseLines(
  progress: FirstSyncProgress,
  tracker: Tracker,
  wait: FirstRunWait,
  s: Settings,
): PhaseLine[] {
  const phase = firstSyncPhase(progress, wait);
  const headers = countLine(progress.headers, tracker.counts.headers, tracker.lines.headers, s);
  const lines: PhaseLine[] = [
    {
      phase: "headers",
      label: s["strings.first_sync.headers"],
      ...headers,
      state: progress.headers.complete ? "done" : "active",
    },
  ];
  if (wait === "inbox_bodies") {
    const waiting = phase === "headers";
    const bodies = countLine(progress.bodies, tracker.counts.bodies, tracker.lines.bodies, s);
    lines.push({
      phase: "bodies",
      label: s["strings.first_sync.bodies"],
      ...(waiting ? { detail: s["strings.first_sync.next"], fraction: 0 } : bodies),
      state: progress.bodies.complete ? "done" : waiting ? "waiting" : "active",
    });
  }
  return lines;
}
