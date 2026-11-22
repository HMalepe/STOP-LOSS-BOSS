/**
 * A single-consumer async queue: producers push, one `for await` reads in order.
 * - `maxBuffer`: if the reader falls this far behind (a stalled SSE client), the channel closes instead of growing
 *   memory without limit; the client reconnects and resumes from its last sequence number.
 * - Breaking out of `for await` (or calling `return()`) closes it and runs `onClose`, so subscribers can be removed.
 */
export class Channel<T> implements AsyncIterable<T> {
  readonly #buffer: T[] = [];
  readonly #readers: ((r: IteratorResult<T>) => void)[] = [];
  readonly #maxBuffer: number;
  readonly #onClose: (() => void) | undefined;
  #closed = false;
  #overflowed = false;

  constructor(opts: { readonly maxBuffer?: number; readonly onClose?: () => void } = {}) {
    this.#maxBuffer = opts.maxBuffer ?? Number.POSITIVE_INFINITY;
    this.#onClose = opts.onClose;
  }

  /** True if this channel was closed because its reader fell too far behind. */
  get overflowed(): boolean {
    return this.#overflowed;
  }

  push(value: T): void {
    if (this.#closed) return;
    const reader = this.#readers.shift();
    if (reader !== undefined) {
      reader({ value, done: false });
      return;
    }
    if (this.#buffer.length >= this.#maxBuffer) {
      this.#overflowed = true;
      this.close();
      return;
    }
    this.#buffer.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const reader of this.#readers.splice(0)) reader({ value: undefined, done: true });
    this.#onClose?.();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.#buffer.length > 0) {
          return Promise.resolve({ value: this.#buffer.shift() as T, done: false });
        }
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#readers.push(resolve));
      },
      return: () => {
        this.#buffer.length = 0;
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** A promise plus the function that resolves it. */
export class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

/** For fire-and-forget promises whose failure is already handled elsewhere. */
export const ignore = (): undefined => undefined;
