/**
 * Non-negotiable 7: the same planId twice = one set of broker calls.
 * The claim is the single gate: whoever claims a planId first runs it; everyone else gets the existing execution id.
 * In memory for now (atomic: JS runs the check-and-set without interleaving). Phase 05/06: a DB unique constraint on
 * executions.plan_id, same interface.
 */
export interface ExecutionStore {
  /** Atomically claim a plan. `created: false` means it was already claimed, and `executionId` is that execution. */
  claim(
    planId: string,
    newExecutionId: string,
  ): Promise<{ readonly executionId: string; readonly created: boolean }>;
}

export class InMemoryExecutionStore implements ExecutionStore {
  readonly #byPlan = new Map<string, string>();

  claim(planId: string, newExecutionId: string): Promise<{ executionId: string; created: boolean }> {
    const existing = this.#byPlan.get(planId);
    if (existing !== undefined) return Promise.resolve({ executionId: existing, created: false });
    this.#byPlan.set(planId, newExecutionId);
    return Promise.resolve({ executionId: newExecutionId, created: true });
  }
}
