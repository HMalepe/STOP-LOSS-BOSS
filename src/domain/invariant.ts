/** A condition the maths guarantees. If it ever fails, it's a bug in our code, not bad input: stop loudly. */
export class InvariantError extends Error {
  constructor(message: string) {
    super(`Invariant violated: ${message}`);
    this.name = "InvariantError";
  }
}

export function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new InvariantError(message);
}
