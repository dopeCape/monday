// Deployment modes and what each can do (docs/spec/architecture.md, "Deployment
// modes"; research 22 section 2.3). The Server reports these from
// /capabilities and the client's Server settings page reads the same table to
// show what an upgrade adds. Runtime-neutral: plain data.

import type { DeploymentMode } from "./domain.ts";

/**
 * Which Servers are alive around one database: the Sidecar alone, a Cloud
 * alone, or both sharing one Postgres (ADR 0005).
 */
export type Topology = "sidecar" | "cloud" | "both";

export const CLOUD_MODES: readonly DeploymentMode[] = ["container", "vercel", "netlify"];

export function isCloudMode(mode: DeploymentMode): boolean {
  return CLOUD_MODES.includes(mode);
}

/** The wake transport a mode offers the client for the Changes feed. */
export type Realtime = "websocket" | "sse" | "polling";

/** What a running Server in one mode can do on its own. */
export interface ModeFeatures {
  realtime: Realtime;
  /** Holds IMAP IDLE and JMAP EventSource open; runs Local runtime steps. */
  holdsConnections: boolean;
  /** Reachable from the internet, so Gmail, Graph and JMAP push webhooks can point here. */
  pushWebhooks: boolean;
  /** Runs a scheduled send at its time even when every laptop is closed. */
  scheduledSendsWhileClosed: boolean;
  /** Runs Jobs between requests: the in-process loop, or a cron plus queue kicker. */
  backgroundJobs: boolean;
  /** Can drive a Local runtime (Claude Code, Codex, OpenCode) on this machine. */
  localRuntimes: boolean;
}

export const DEPLOYMENT_FEATURES: Record<DeploymentMode, ModeFeatures> = {
  sidecar: {
    realtime: "websocket",
    holdsConnections: true,
    pushWebhooks: false,
    scheduledSendsWhileClosed: false,
    backgroundJobs: true,
    localRuntimes: true,
  },
  container: {
    realtime: "websocket",
    holdsConnections: true,
    pushWebhooks: true,
    scheduledSendsWhileClosed: true,
    backgroundJobs: true,
    localRuntimes: false,
  },
  vercel: {
    realtime: "sse",
    holdsConnections: false,
    pushWebhooks: true,
    scheduledSendsWhileClosed: true,
    backgroundJobs: true,
    localRuntimes: false,
  },
  netlify: {
    realtime: "polling",
    holdsConnections: false,
    pushWebhooks: true,
    scheduledSendsWhileClosed: true,
    backgroundJobs: true,
    localRuntimes: false,
  },
};

/** The union of what a set of live Servers can do together ("both" is the sum of its parts). */
export function combinedFeatures(modes: readonly DeploymentMode[]): ModeFeatures {
  const list = modes.length > 0 ? modes : (["sidecar"] as const);
  const any = (pick: (f: ModeFeatures) => boolean) =>
    list.some((m) => pick(DEPLOYMENT_FEATURES[m]));
  const realtime: Realtime = list.some((m) => DEPLOYMENT_FEATURES[m].realtime === "websocket")
    ? "websocket"
    : list.some((m) => DEPLOYMENT_FEATURES[m].realtime === "sse")
      ? "sse"
      : "polling";
  return {
    realtime,
    holdsConnections: any((f) => f.holdsConnections),
    pushWebhooks: any((f) => f.pushWebhooks),
    scheduledSendsWhileClosed: any((f) => f.scheduledSendsWhileClosed),
    backgroundJobs: any((f) => f.backgroundJobs),
    localRuntimes: any((f) => f.localRuntimes),
  };
}

/** The Topology a set of live Server modes forms. */
export function topologyOf(modes: readonly DeploymentMode[]): Topology {
  const cloud = modes.some(isCloudMode);
  const sidecar = modes.includes("sidecar");
  if (cloud && sidecar) return "both";
  if (cloud) return "cloud";
  return "sidecar";
}

/* ------------------------------ Upgrade cards (ADR 0008) ------------------------------ */

export type CloudPlatform = "vercel" | "netlify" | "container";

/** One environment variable a Cloud deployment needs, as the upgrade card lists it. */
export interface EnvVar {
  name: string;
  /** What to put in it, in one sentence. */
  help: string;
  required: boolean;
}

/** Variables every Cloud mode reads; the platform cards add their own. */
export const CLOUD_ENV: readonly EnvVar[] = [
  {
    name: "DATABASE_URL",
    help: "The pooled connection string of your Postgres (Neon's -pooler host, Supabase port 6543).",
    required: true,
  },
  {
    name: "DATABASE_URL_UNPOOLED",
    help: "The direct connection string, used for migrations and the database copy.",
    required: false,
  },
  {
    name: "MONDAY_SETUP_CODE",
    help: "A one-time code of your choosing; this device pairs with it once, then it stops working.",
    required: true,
  },
  {
    name: "MONDAY_PUBLIC_URL",
    help: "The https:// address of the deployment, where Gmail and Microsoft push notifications arrive.",
    required: true,
  },
  {
    name: "MONDAY_ROOT_KEY",
    help: "Your root key, only if the Cloud should read mail for Briefs and Workflows while every device is off.",
    required: false,
  },
];

export const PLATFORM_ENV: Record<CloudPlatform, readonly EnvVar[]> = {
  vercel: [
    { name: "MONDAY_MODE", help: "vercel", required: true },
    {
      name: "CRON_SECRET",
      help: "A random string; Vercel Cron sends it so nobody else can trigger the Job tick.",
      required: true,
    },
  ],
  netlify: [{ name: "MONDAY_MODE", help: "netlify", required: true }],
  container: [
    { name: "MONDAY_MODE", help: "container", required: true },
    { name: "PORT", help: "The port to listen on; 8787 in the compose file.", required: false },
  ],
};

export interface DeployLink {
  platform: CloudPlatform;
  url: string;
  env: EnvVar[];
}

/**
 * The Deploy button's target with the repository prefilled. Vercel and Netlify
 * accept a clone URL with a root directory; the container card opens the
 * self-hosting guide, since there is nothing to click through.
 */
export function deployLink(platform: CloudPlatform, repo: string): DeployLink {
  const env = [...CLOUD_ENV, ...PLATFORM_ENV[platform]];
  const names = env.map((e) => e.name).join(",");
  const description = "See the Server page in monday's settings for what each value is.";
  let url: string;
  switch (platform) {
    case "vercel": {
      const q = new URLSearchParams({
        "repository-url": repo,
        "root-directory": "apps/server",
        "project-name": "monday-server",
        env: names,
        envDescription: description,
      });
      url = `https://vercel.com/new/clone?${q}`;
      break;
    }
    case "netlify": {
      const q = new URLSearchParams({ repository: repo, base: "apps/server" });
      url = `https://app.netlify.com/start/deploy?${q}`;
      break;
    }
    case "container":
      url = `${repo.replace(/\/+$/, "")}/blob/main/apps/server/deploy/README.md`;
      break;
  }
  return { platform, url, env };
}
