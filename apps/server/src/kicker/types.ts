// A kicker is what wakes the step runner on a given host (research 22, section 2).
// The jobs table is the source of truth; a kicker only says "there may be work".

import type { DeploymentMode } from "@monday/shared";
import type { Db } from "../db/client.ts";
import type { Jobs } from "../jobs/index.ts";

export interface KickerOptions {
  jobs: Jobs;
  db: Db;
  /** This Server's heartbeat id. Also the lease owner on claimed jobs. */
  serverId: string;
  mode: DeploymentMode;
  /** The need tags this Server can serve right now. Evaluated before every claim. */
  canServe: () => Promise<string[]> | string[];
  /** Milliseconds a claimed step may run before its lease expires (server.job_lease_seconds). */
  budgetMs?: number | (() => Promise<number> | number);
  /** Steps run at once (server.job_workers); one when absent. */
  workers?: number | (() => Promise<number> | number);
  log?: (message: string) => void;
}

export interface Kicker {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Hint that a job may be runnable now. Safe to call at any time. */
  wake(): void;
}
