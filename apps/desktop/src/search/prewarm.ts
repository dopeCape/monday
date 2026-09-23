// The pre-warm Job (ADR 0011): fills the Cache with bodies, newest first,
// back to `search.cache_window_days`, within `search.cache_cap_gb`, and only
// while the platform reports an unmetered connection and mains power (each
// overridable by its Setting). It pauses otherwise and resumes when the
// conditions return. Above the cap the least recently used bodies go first:
// `messages.body_at` is when a body arrived or was last read, and eviction
// clears bodies in that order until the Cache fits again.
//
// The Job is a loop of steps over the Store; nothing here talks to the
// network except through `fetchBodies`, the same seam "search older mail"
// uses, and the platform through `conditions`.

import type { NetworkInfo, PowerInfo } from "../platform/tauri.ts";
import type { Statement } from "../store/driver.ts";
import type { Store } from "../store/store.ts";
import type { FetchBodies } from "./index.ts";

export interface PrewarmSettings {
  /** How many days back bodies are fetched. */
  windowDays: number;
  /** The most the bodies may occupy, in gigabytes. */
  capGb: number;
  onMetered: boolean;
  onBattery: boolean;
  /** Bodies per request. */
  batch: number;
}

export interface PrewarmConditions {
  network(): Promise<NetworkInfo>;
  power(): Promise<PowerInfo>;
}

export type PauseReason = "offline" | "metered" | "battery";

export type PrewarmStep =
  | { kind: "fetched"; landed: number; evicted: number }
  | { kind: "paused"; reason: PauseReason }
  /** Every body inside the window is in the Cache. */
  | { kind: "done"; evicted: number }
  /** The cap is reached before the window is; nothing more is fetched. */
  | { kind: "capped"; evicted: number };

export interface PrewarmStatus {
  last: PrewarmStep | null;
  /** Bytes the bodies occupy after the last step. */
  bytes: number;
  running: boolean;
}

export interface PrewarmOptions {
  store: Store;
  fetchBodies: FetchBodies;
  conditions: PrewarmConditions;
  settings: () => PrewarmSettings;
  now?: () => Date;
  /** Delays between steps, small in tests. */
  timing?: { betweenBatchesMs?: number; pausedMs?: number; idleMs?: number };
  log?: (message: string) => void;
}

export interface Prewarm {
  /** One step: evict above the cap, check conditions, fetch one batch. */
  step(): Promise<PrewarmStep>;
  /** Runs steps on a timer until stopped; returns the stop function. */
  start(): () => void;
  status(): PrewarmStatus;
}

const GB = 1024 ** 3;
const DAY_MS = 86_400_000;

/** How many bytes of body text and html the Cache holds. */
export async function bodyBytes(store: Store): Promise<number> {
  const [row] = await store.query<{ n: number | null }>(
    "select sum(length(body_text) + coalesce(length(body_html), 0)) as n from messages where body_text is not null",
  );
  return Number(row?.n ?? 0);
}

export interface Eviction {
  count: number;
  /** The newest Message date among the evicted bodies, or null when none went. */
  newest: string | null;
}

/**
 * Clears the least recently used bodies until the Cache fits under `capBytes`.
 * Header rows stay; a cleared body reads as missing, so a later search can
 * offer to fetch it again.
 */
export async function evictToCap(store: Store, capBytes: number): Promise<Eviction> {
  let bytes = await bodyBytes(store);
  if (bytes <= capBytes) return { count: 0, newest: null };
  const rows = await store.query<{ id: string; date: string; size: number }>(
    `select id, date, length(body_text) + coalesce(length(body_html), 0) as size
     from messages where body_text is not null
     order by body_at asc, date asc`,
  );
  const victims: string[] = [];
  let newest: string | null = null;
  for (const r of rows) {
    if (bytes <= capBytes) break;
    victims.push(r.id);
    bytes -= Number(r.size);
    if (newest === null || r.date > newest) newest = r.date;
  }
  if (victims.length === 0) return { count: 0, newest: null };
  await store.write(
    victims.map((id) => ({
      sql: "update messages set body_text = null, body_html = null, body_at = null where id = ?",
      params: [id],
    })),
  );
  return { count: victims.length, newest };
}

const FLOOR_KEY = "prewarm_floor";
const FLOOR_CAP_KEY = "prewarm_floor_cap";
/** The guess for a body before the Cache holds any, for the cap check. */
const DEFAULT_BODY_BYTES = 4 * 1024;

export function createPrewarm(options: PrewarmOptions): Prewarm {
  const { store, fetchBodies, conditions } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const timing = {
    betweenBatchesMs: options.timing?.betweenBatchesMs ?? 50,
    pausedMs: options.timing?.pausedMs ?? 60_000,
    idleMs: options.timing?.idleMs ?? 10 * 60_000,
  };
  let last: PrewarmStep | null = null;
  let bytes = 0;
  let running = false;

  const pauseReason = async (s: PrewarmSettings): Promise<PauseReason | null> => {
    const network = await conditions.network();
    if (!network.online) return "offline";
    if (network.metered && !s.onMetered) return "metered";
    const power = await conditions.power();
    if (!power.mains && !s.onBattery) return "battery";
    return null;
  };

  /**
   * The floor: the newest date eviction has reached. Missing bodies at or
   * below it are not fetched again, so a full Cache does not churn between
   * the Job and the LRU. A larger cap than the one the floor was set under
   * clears it.
   */
  const readFloor = async (capGb: number): Promise<string | null> => {
    const rows = await store.query<{ key: string; value: string }>(
      "select key, value from meta where key in (?, ?)",
      [FLOOR_KEY, FLOOR_CAP_KEY],
    );
    const floor = rows.find((r) => r.key === FLOOR_KEY)?.value ?? null;
    const cap = Number(rows.find((r) => r.key === FLOOR_CAP_KEY)?.value ?? 0);
    if (floor !== null && capGb > cap) {
      await store.write([
        { sql: "delete from meta where key in (?, ?)", params: [FLOOR_KEY, FLOOR_CAP_KEY] },
      ]);
      return null;
    }
    return floor;
  };

  const raiseFloor = async (floor: string | null, to: string, capGb: number): Promise<string> => {
    const next = floor === null || to > floor ? to : floor;
    const upsert =
      "insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value";
    await store.write([
      { sql: upsert, params: [FLOOR_KEY, next] },
      { sql: upsert, params: [FLOOR_CAP_KEY, String(capGb)] },
    ]);
    return next;
  };

  const step = async (): Promise<PrewarmStep> => {
    const s = options.settings();
    const capBytes = s.capGb * GB;
    let floor = await readFloor(s.capGb);
    const eviction = await evictToCap(store, capBytes);
    if (eviction.newest !== null) floor = await raiseFloor(floor, eviction.newest, s.capGb);
    const evicted = eviction.count;
    bytes = await bodyBytes(store);
    const finish = (result: PrewarmStep) => {
      last = result;
      return result;
    };

    const reason = await pauseReason(s);
    if (reason) return finish({ kind: "paused", reason });

    const windowStart = new Date(now().getTime() - s.windowDays * DAY_MS).toISOString();
    const [next] = await store.query<{ date: string }>(
      "select date from messages where body_text is null and body_at is null and date >= ? and date > ? order by date desc limit 1",
      [windowStart, floor ?? ""],
    );
    if (!next) return finish({ kind: "done", evicted });

    // The cap is checked before fetching, with the Cache's own average body
    // size, so the Job stops short of the cap instead of landing past it and
    // evicting what it just fetched.
    const [held] = await store.query<{ n: number }>(
      "select count(*) as n from messages where body_text is not null",
    );
    const count = Number(held?.n ?? 0);
    const average = count > 0 ? bytes / count : DEFAULT_BODY_BYTES;
    if (bytes >= capBytes || (count > 0 && bytes + average * s.batch > capBytes)) {
      return finish({ kind: "capped", evicted });
    }

    // Newest first: the batch ends just past the newest Message still missing a body.
    const before = new Date(Date.parse(next.date) + 1).toISOString();
    const page = await fetchBodies(store.workspaceId, {
      after: windowStart,
      before,
      limit: s.batch,
    });
    const landed = await store.applyBodies(page.bodies, now().toISOString());
    // A Message the Server has no body for yet (its sync has not fetched it)
    // is marked tried, body_at without a body, so the loop moves on; the body
    // itself stays missing, and the reader asks for it on open. A "message"
    // change from the feed clears the mark, so a later pass tries again.
    const notYet = page.bodies
      .filter((b) => b.bodyState !== undefined && b.bodyState !== "fetched")
      .map((b) => b.id);
    const stamp = now().toISOString();
    const marks: Statement[] = [];
    if (notYet.length > 0) {
      marks.push({
        sql: `update messages set body_at = ? where body_text is null and id in (${notYet.map(() => "?").join(", ")})`,
        params: [stamp, ...notYet],
      });
    }
    if (landed === 0 && page.bodies.length === 0) {
      // The Server has nothing for the gap (a Message it does not hold); mark it so the loop moves on.
      marks.push({
        sql: "update messages set body_at = ? where body_text is null and body_at is null and date >= ? and date < ?",
        params: [stamp, windowStart, before],
      });
    }
    if (marks.length > 0) await store.write(marks);
    bytes = await bodyBytes(store);
    log(`pre-warm: ${landed} bodies landed, ${bytes} bytes held`);
    return finish({ kind: "fetched", landed, evicted });
  };

  return {
    step,

    start() {
      if (running) return () => {};
      running = true;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const loop = async () => {
        if (!running) return;
        let delay = timing.idleMs;
        try {
          const result = await step();
          if (result.kind === "fetched") delay = timing.betweenBatchesMs;
          else if (result.kind === "paused") delay = timing.pausedMs;
        } catch (error) {
          log(`pre-warm failed: ${error instanceof Error ? error.message : String(error)}`);
          delay = timing.pausedMs;
        }
        if (running) timer = setTimeout(() => void loop(), delay);
      };
      void loop();
      return () => {
        running = false;
        if (timer) clearTimeout(timer);
      };
    },

    status: () => ({ last, bytes, running }),
  };
}
