/** A minimal single-consumer async queue: producers push, one `for await` reads in order. */
export class Channel<T> implements AsyncIterable<T> {
  readonly #buffer: T[] = [];
  readonly #readers: ((r: IteratorResult<T>) => void)[] = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const reader = this.#readers.shift();
    if (reader === undefined) this.#buffer.push(value);
    else reader({ value, done: false });
  }

  close(): void {
    this.#closed = true;
    for (const reader of this.#readers.splice(0)) reader({ value: undefined, done: true });
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
    };
  }
}
