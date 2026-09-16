// What this Server can do, by deployment mode (docs/spec/architecture.md,
// "Deployment modes"; research 22 section 2.3). The client reads this once
// after pairing and picks its realtime transport from it.

import type { Capabilities, DeploymentMode } from "@monday/shared";

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

const TABLE: Record<DeploymentMode, Omit<Capabilities, "protocol" | "mode">> = {
  sidecar: { realtime: "websocket", holdsConnections: true, publicUrl: false, localRuntimes: true },
  container: {
    realtime: "websocket",
    holdsConnections: true,
    publicUrl: true,
    localRuntimes: false,
  },
  vercel: { realtime: "sse", holdsConnections: false, publicUrl: true, localRuntimes: false },
  netlify: { realtime: "polling", holdsConnections: false, publicUrl: true, localRuntimes: false },
};

export function capabilitiesFor(mode: DeploymentMode): Capabilities {
  return { protocol: PROTOCOL_VERSION, mode, ...TABLE[mode] };
}

/** The need tags a Server in this mode can serve on its own (ADR 0005). */
export function needsServedBy(mode: DeploymentMode): string[] {
  const caps = TABLE[mode];
  const needs: string[] = [];
  if (caps.holdsConnections) needs.push("needs-process");
  if (caps.publicUrl) needs.push("needs-public-url");
  return needs;
}
