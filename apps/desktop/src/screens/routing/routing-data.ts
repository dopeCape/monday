// The seam between the Routing screen and the data under it: Groups and the
// Needs a decision queue as the Cache holds them (the feed keeps both
// current), handed to the screen as one stable external store. The Server
// side of the page (Examples, Confidence, the re-run) goes through the API.
// fixtureRouting() is the in-memory implementation over packages/ui fixtures.

import type { DecisionCandidate, Group } from "@monday/shared";
import { decisions as fixtureDecisions, groups as fixtureGroups } from "@monday/ui/fixtures";
import {
  type CachedDecision,
  DECISIONS_SQL,
  GROUPS_SQL,
  rowToDecision,
  rowToGroup,
  type Store,
} from "../../store/index.ts";

export type { CachedDecision } from "../../store/index.ts";

export interface RoutingSource {
  /** Every Group, top-level first. Stable between changes. */
  groups(): readonly Group[];
  /** Needs a decision, newest first. Stable between changes. */
  decisions(): readonly CachedDecision[];
  subscribe(listener: () => void): () => void;
}

export interface StoreRouting extends RoutingSource {
  close(): void;
}

/** Opens the seam over the Store's live queries and resolves once both have rows. */
export async function createStoreRouting(store: Store): Promise<StoreRouting> {
  const listeners = new Set<() => void>();
  let groups: readonly Group[] = [];
  let decisions: readonly CachedDecision[] = [];
  const emit = () => {
    for (const l of [...listeners]) l();
  };
  const groupsLive = store.live<Record<string, unknown>>(GROUPS_SQL);
  const decisionsLive = store.live<Record<string, unknown>>(DECISIONS_SQL);
  await Promise.all([
    new Promise<void>((resolve) => {
      groupsLive.subscribe((rows) => {
        groups = rows.map((r) => rowToGroup(r, store.workspaceId));
        emit();
        resolve();
      });
    }),
    new Promise<void>((resolve) => {
      decisionsLive.subscribe((rows) => {
        decisions = rows.map(rowToDecision);
        emit();
        resolve();
      });
    }),
  ]);
  return {
    groups: () => groups,
    decisions: () => decisions,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      groupsLive.close();
      decisionsLive.close();
      listeners.clear();
    },
  };
}

/** The design fixtures as a RoutingSource; the decisions may be answered, which drops them. */
export function fixtureRouting(
  seedGroups: readonly Group[] = fixtureGroups,
  seedDecisions: readonly {
    threadId: string;
    candidates: DecisionCandidate[];
  }[] = fixtureDecisions,
): RoutingSource & { settle(threadId: string): void } {
  const listeners = new Set<() => void>();
  let decisions: CachedDecision[] = seedDecisions.map((d) => ({
    threadId: d.threadId,
    candidates: d.candidates,
    at: "2026-09-16T09:00:00.000Z",
    subject: "",
    participants: [],
  }));
  return {
    groups: () => seedGroups,
    decisions: () => decisions,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    settle(threadId) {
      decisions = decisions.filter((d) => d.threadId !== threadId);
      for (const l of [...listeners]) l();
    },
  };
}
