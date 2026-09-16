// RFC 8620 section 7.3 push: one long-lived text/event-stream connection that
// carries StateChange objects. Reconnects with exponential backoff, accepts
// both "@type" and "type" (Fastmail once shipped the latter), and treats a
// missing ping as a dead stream. The pump is written against an abstract
// opener and clock so tests drive it without sockets.

import type { WatchEvent } from "../types.ts";

export interface StateChange {
  changed: Record<string, Record<string, string>>;
}

export interface SseEvent {
  event: string;
  data: string;
  id: string | null;
}

/** Incremental parser for the text/event-stream framing. */
export class SseParser {
  private buffer = "";
  private event = "message";
  private data: string[] = [];
  private id: string | null = null;

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    let index = this.buffer.search(/\r\n|\n|\r/);
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      const sep = this.buffer.slice(index).match(/^\r\n|\n|\r/)?.[0] ?? "\n";
      this.buffer = this.buffer.slice(index + sep.length);
      const ready = this.line(line);
      if (ready) out.push(ready);
      index = this.buffer.search(/\r\n|\n|\r/);
    }
    return out;
  }

  private line(line: string): SseEvent | null {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = "message";
        return null;
      }
      const ready = { event: this.event, data: this.data.join("\n"), id: this.id };
      this.event = "message";
      this.data = [];
      return ready;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    else if (field === "id") this.id = value;
    return null;
  }
}

/** Reads a StateChange leniently: "@type" per the RFC, "type" as some servers send it. */
export function parseStateChange(data: string): StateChange | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const type = parsed["@type"] ?? parsed.type;
    if (type !== undefined && type !== "StateChange") return null;
    const changed = parsed.changed;
    if (!changed || typeof changed !== "object") return null;
    return { changed: changed as Record<string, Record<string, string>> };
  } catch {
    return null;
  }
}

export interface Backoff {
  initialMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: Backoff = { initialMs: 1_000, maxMs: 60_000 };

export function nextBackoff(current: number, backoff: Backoff = DEFAULT_BACKOFF): number {
  if (current <= 0) return backoff.initialMs;
  return Math.min(backoff.maxMs, current * 2);
}

export interface Stream {
  /** Chunks of decoded text. */
  chunks: AsyncIterable<string>;
  close(): void;
}

export interface PumpOptions {
  open(): Promise<Stream>;
  /** Called with each StateChange; returns the WatchEvent to emit, or null to drop. */
  onChange(change: StateChange): WatchEvent | null;
  /** How long without any event (state or ping) before the stream is declared dead. */
  idleTimeoutMs: number;
  backoff?: Backoff;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs the reconnect loop until stop() is called. Yields "connected" after
 * every successful open, "disconnected" with the reason before each retry,
 * and the events onChange produces.
 */
export function eventSourcePump(options: PumpOptions): {
  events: AsyncIterable<WatchEvent>;
  stop(): void;
} {
  const sleep = options.sleep ?? defaultSleep;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  let stopped = false;
  let current: Stream | null = null;
  let wakeSleep: (() => void) | null = null;

  const interruptibleSleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wakeSleep = resolve;
      void sleep(ms).then(() => {
        wakeSleep = null;
        resolve();
      });
    });

  async function* run(): AsyncGenerator<WatchEvent> {
    let delay = 0;
    while (!stopped) {
      let stream: Stream;
      try {
        stream = await options.open();
      } catch (error) {
        delay = nextBackoff(delay, backoff);
        yield { type: "disconnected", reason: error instanceof Error ? error.message : "open" };
        await interruptibleSleep(delay);
        continue;
      }
      if (stopped) {
        stream.close();
        return;
      }
      current = stream;
      delay = 0;
      yield { type: "connected" };
      const parser = new SseParser();
      let reason = "closed";
      try {
        for await (const chunk of withIdleTimeout(stream, options.idleTimeoutMs)) {
          for (const event of parser.push(chunk)) {
            if (event.event === "ping") continue;
            if (event.event !== "state" && event.event !== "message") continue;
            const change = parseStateChange(event.data);
            if (!change) continue;
            const out = options.onChange(change);
            if (out) yield out;
          }
        }
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      } finally {
        stream.close();
        current = null;
      }
      if (stopped) return;
      delay = nextBackoff(delay, backoff);
      yield { type: "disconnected", reason };
      await interruptibleSleep(delay);
    }
  }

  return {
    events: run(),
    stop() {
      stopped = true;
      current?.close();
      wakeSleep?.();
    },
  };
}

/** Wraps the stream so silence longer than the timeout ends it with an error. */
async function* withIdleTimeout(stream: Stream, timeoutMs: number): AsyncIterable<string> {
  const iterator = stream.chunks[Symbol.asyncIterator]();
  while (true) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("event stream idle")), timeoutMs);
    });
    try {
      const next = await Promise.race([iterator.next(), timeout]);
      if (next.done) return;
      yield next.value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Turns a fetch Response body into a Stream of text chunks. */
export function streamOfResponse(response: Response): Stream {
  const body = response.body;
  if (!body) return { chunks: (async function* () {})(), close() {} };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let closed = false;
  return {
    chunks: (async function* () {
      try {
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value) yield decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    })(),
    close() {
      closed = true;
      reader.cancel().catch(() => {});
    },
  };
}
