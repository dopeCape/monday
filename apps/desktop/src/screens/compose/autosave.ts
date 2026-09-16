// Draft autosave: a 2 s idle debounce (a Setting) and an immediate save on
// blur, as the `draft.save` intent the Store applies locally first, so it
// works offline (ADR 0010). Pure enough to test with fake timers: the
// scheduler takes its clock functions as arguments.

import type { DraftContent } from "@monday/shared";

export interface AutosaveOptions {
  idleMs: number;
  save: (content: DraftContent) => Promise<void>;
  /** Called with true while a save is pending or in flight, false when settled. */
  onState?: ((saving: boolean) => void) | undefined;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface Autosave {
  /** The content changed; saves after the idle window unless another change comes first. */
  change(content: DraftContent): void;
  /** Blur or an explicit request: saves now when anything is pending. */
  flush(): Promise<void>;
  /** Stops the timer without saving. */
  cancel(): void;
  readonly pending: boolean;
  /** Saves made so far, for tests. */
  readonly count: number;
}

const same = (a: DraftContent | null, b: DraftContent) =>
  a !== null && JSON.stringify(a) === JSON.stringify(b);

export function createAutosave(options: AutosaveOptions): Autosave {
  const set = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let latest: DraftContent | null = null;
  let saved: DraftContent | null = null;
  let inflight: Promise<void> | null = null;
  let count = 0;

  const run = async () => {
    if (!latest || same(saved, latest)) {
      options.onState?.(false);
      return;
    }
    const content = latest;
    inflight = options.save(content).then(() => {
      saved = content;
      count += 1;
    });
    try {
      await inflight;
    } finally {
      inflight = null;
      if (latest && !same(saved, latest)) {
        // Changed while saving: go again after the idle window.
        timer = set(() => {
          timer = null;
          void run();
        }, options.idleMs);
      } else {
        options.onState?.(false);
      }
    }
  };

  return {
    change(content) {
      latest = content;
      if (same(saved, content)) return;
      options.onState?.(true);
      if (timer !== null) clear(timer);
      timer = set(() => {
        timer = null;
        void run();
      }, options.idleMs);
    },
    async flush() {
      if (timer !== null) {
        clear(timer);
        timer = null;
      }
      if (inflight) await inflight;
      await run();
    },
    cancel() {
      if (timer !== null) clear(timer);
      timer = null;
      latest = saved;
      options.onState?.(false);
    },
    get pending() {
      return timer !== null || inflight !== null;
    },
    get count() {
      return count;
    },
  };
}
