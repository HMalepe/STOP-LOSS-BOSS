/**
 * Bounds concurrent password hashing. argon2id at production cost uses 64 MiB per verify: an unbounded flood of login
 * POSTs would exhaust memory (docs/05). A few run at once, a few more wait their turn, the rest are told to come back.
 */
export class HashGate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly max: number;
  private readonly maxQueue: number;

  constructor(max: number, maxQueue: number) {
    this.max = max;
    this.maxQueue = maxQueue;
  }

  /** null = too busy right now. Otherwise resolves, once a slot is free, to the function that gives it back. */
  enter(): Promise<() => void> | null {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    if (this.waiting.length >= this.maxQueue) return null;
    return new Promise((resolve) => {
      this.waiting.push(() => {
        resolve(this.releaser());
      });
    });
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  /** Each slot is released exactly once, however many times its release is called. */
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next === undefined) this.active--;
      else next(); // hand the slot straight over: `active` stays the same
    };
  }
}
