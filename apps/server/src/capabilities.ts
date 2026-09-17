// What this Server can do, by deployment mode (docs/spec/architecture.md,
// "Deployment modes"; research 22 section 2.3). The client reads this once
// after pairing and picks its realtime transport from it, and again from the
// Server settings page to show the topology (Sidecar only, Cloud, both) and
// what the live Servers can do together.

import {
  type Capabilities,
  combinedFeatures,
  DEPLOYMENT_FEATURES,
  type DeploymentMode,
  type HostedState,
  isCloudMode,
} from "@monday/shared";
import type { TopologyView } from "./heartbeat.ts";

export const PROTOCOL_VERSION = 1;

export const DEPLOYMENT_MODES: readonly DeploymentMode[] = [
  "sidecar",
  "container",
  "vercel",
  "netlify",
];

export function isDeploymentMode(value: unknown): value is DeploymentMode {
  return typeof value === "string" && (DEPLOYMENT_MODES as readonly string[]).includes(value);
}

/* ------------------------------ Need tags (ADR 0005) ------------------------------ */

/** Provider push webhooks: only a Server the internet can reach. */
export const PUBLIC_URL_NEED = "needs-public-url";
/** IMAP IDLE, JMAP EventSource, Local runtime steps: only a process that stays up. */
export const PROCESS_NEED = "needs-process";
/**
 * Time-critical work such as a scheduled send: a Cloud when one is alive, so
 * it happens while every laptop is closed; the Sidecar when no Cloud is.
 */
export const ALWAYS_ON_NEED = "needs-always-on";

/** The need tags a Server in this mode can serve on its own. */
export function needsServedBy(mode: DeploymentMode): string[] {
  const caps = DEPLOYMENT_FEATURES[mode];
  const needs: string[] = [];
  if (caps.holdsConnections) needs.push(PROCESS_NEED);
  if (caps.pushWebhooks) needs.push(PUBLIC_URL_NEED);
  if (isCloudMode(mode)) needs.push(ALWAYS_ON_NEED);
  return needs;
}

/** The tags only a Cloud serves while one is alive; the Sidecar takes them over otherwise. */
export const CLOUD_NEEDS: readonly string[] = [PUBLIC_URL_NEED, ALWAYS_ON_NEED];

/**
 * The failover rule: a Sidecar with no fresh Cloud heartbeat claims every
 * class, including the Cloud's (ADR 0005). A Cloud, or a Sidecar beside a
 * live Cloud, claims only what its mode serves.
 */
export function claimableNeeds(mode: DeploymentMode, cloudAlive: boolean): string[] {
  const own = needsServedBy(mode);
  if (mode === "sidecar" && !cloudAlive) return [...new Set([...own, ...CLOUD_NEEDS])];
  return own;
}

/* ------------------------------ /capabilities ------------------------------ */

/**
 * `unlocked` is process state, not a mode property: whether K_root is in
 * memory right now. `topology` is what the heartbeats say; absent, the
 * Server is taken to be alone.
 */
export function capabilitiesFor(
  mode: DeploymentMode,
  unlocked: boolean,
  hosted: HostedState,
  topology?: TopologyView,
): Capabilities {
  const own = DEPLOYMENT_FEATURES[mode];
  const view: TopologyView = topology ?? {
    topology: isCloudMode(mode) ? "cloud" : "sidecar",
    modes: [mode],
    servers: [],
  };
  return {
    protocol: PROTOCOL_VERSION,
    mode,
    realtime: own.realtime,
    holdsConnections: own.holdsConnections,
    publicUrl: own.pushWebhooks,
    localRuntimes: own.localRuntimes,
    unlocked,
    hosted,
    topology: view.topology,
    features: combinedFeatures(view.modes),
    servers: view.servers.map((s) => ({
      id: s.id,
      mode: s.mode,
      lastSeen: s.lastSeen.toISOString(),
    })),
  };
}
