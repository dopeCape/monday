// An unbounded async queue: producers push, one consumer iterates. Used to
// multiplex several push connections into one Watch.

export interface AsyncQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(): void;
  readonly closed: boolean;
}

export function asyncQueue<T>(): AsyncQueue<T> {
  const buffer: T[] = [];
  let waiting: ((result: IteratorResult<T>) => void) | null = null;
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    push(value) {
      if (closed) return;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value, done: false });
      } else {
        buffer.push(value);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: undefined as never, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<T>>((resolve) => {
            const value = buffer.shift();
            if (value !== undefined) resolve({ value, done: false });
            else if (closed) resolve({ value: undefined as never, done: true });
            else waiting = resolve;
          }),
        return: async () => {
          closed = true;
          return { value: undefined as never, done: true };
        },
      };
    },
  };
}
