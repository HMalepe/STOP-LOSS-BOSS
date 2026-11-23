/**
 * Non-negotiable 7: the same planId twice = one set of broker calls.
 * The claim is the single gate: whoever claims a planId first runs it; everyone else gets the existing execution id.
 * In memory for now (atomic: JS runs the check-and-set without interleaving), bounded so an always-on process can't grow
 * forever: plans expire in 30 s, so a claim only needs to outlive any replay of that request. Phase 05/06: a DB unique
 * constraint on executions.plan_id, same interface.
 */
import type { ExecItem } from "./types";

export interface ExecutionStore {
  /**
   * Atomically claim a plan. `created: false` means it was already claimed, and `executionId` is that execution.
   * A persistent store records every item as "pending" in the same step, so a restart can tell what was never sent.
   */
  claim(
    planId: string,
    newExecutionId: string,
    items: readonly ExecItem[],
  ): Promise<{ readonly executionId: string; readonly created: boolean }>;
  /** Restart recovery: item `index` is about to be sent ("sending"). Optional: in-memory stores have nothing to recover. */
  markSending?(executionId: string, index: number): Promise<void>;
}

export class InMemoryExecutionStore implements ExecutionStore {
  readonly #byPlan = new Map<string, string>();
  readonly #max: number;

  constructor(maxEntries = 10_000) {
    this.#max = maxEntries;
  }

  // Items aren't needed: nothing in memory survives a restart, so there is nothing to recover.
  claim(planId: string, newExecutionId: string): Promise<{ executionId: string; created: boolean }> {
    const existing = this.#byPlan.get(planId);
    if (existing !== undefined) return Promise.resolve({ executionId: existing, created: false });
    this.#byPlan.set(planId, newExecutionId);
    // Oldest first out (Map keeps insertion order).
    for (const oldest of this.#byPlan.keys()) {
      if (this.#byPlan.size <= this.#max) break;
      this.#byPlan.delete(oldest);
    }
    return Promise.resolve({ executionId: newExecutionId, created: true });
  }
}
