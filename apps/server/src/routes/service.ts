// The Sidecar's background service (ADR 0013), served to the client on this
// computer and to scripts that hold its token:
//   GET  /service        pid, port, build, since when, memory, whether a client is here, what it told
//   POST /service/stop   a graceful stop (finish leases, close Postgres); 202, then the process exits
// Mounted by the Bun entry in sidecar mode only. Stopping is the Sidecar
// principal's alone (its own client's loopback token); a paired Device may read
// the status but not stop the service.

import type { ServiceStatus } from "@monday/shared";
import { Hono } from "hono";
import { type AppEnv, principalOf } from "../auth/middleware.ts";

export interface ServiceControl {
  status(): Promise<ServiceStatus> | ServiceStatus;
  /** Begins the graceful shutdown; called after the answer is on its way. */
  stop(reason: string): void;
}

export function serviceRoutes(control: ServiceControl): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/service", async (c) => c.json(await control.status()));

  app.post("/service/stop", (c) => {
    if (principalOf(c).kind !== "sidecar") return c.json({ error: "forbidden" }, 403);
    // Answer first: the caller waits for the process to go, not for this response.
    setTimeout(() => control.stop("POST /service/stop"), 50);
    return c.json({ stopping: true }, 202);
  });

  return app;
}
