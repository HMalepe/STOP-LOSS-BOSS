/** A timeout we raised ourselves (as opposed to one reported by the broker). */
export class AdapterTimeout extends Error {
  constructor(readonly ms: number) {
    super(`no answer within ${String(ms)} ms`);
    this.name = "AdapterTimeout";
  }
}

/** Race a promise against a timer. The underlying call is NOT cancelled: it may still complete (R6.5). */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new AdapterTimeout(ms));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
