export type RunnerProtocolOperation = "logs" | "complete" | "renew-lease" | "artifacts";

export interface RunnerProtocolAdmissionPort {
  assertAllowed(input: {
    operation: RunnerProtocolOperation;
    runnerId: string;
    maximumConcurrency: number;
  }): Promise<void>;
}

export const RUNNER_PROTOCOL_RATE_WINDOW_MS = 60_000;

const operationBudgets = {
  logs: { resource: 600, minimumRunner: 600, perSlot: 180 },
  complete: { resource: 300, minimumRunner: 300, perSlot: 120 },
  "renew-lease": { resource: 600, minimumRunner: 600, perSlot: 12 },
  artifacts: { resource: 120, minimumRunner: 120, perSlot: 240 },
} satisfies Record<
  RunnerProtocolOperation,
  { resource: number; minimumRunner: number; perSlot: number }
>;

/** Log uploads run at 2 Hz per attempt, not per Runner. Allow headroom for final flushes. */
export function runnerProtocolRateBudget(
  operation: RunnerProtocolOperation,
  maximumConcurrency = 1,
) {
  const budget = operationBudgets[operation];
  return {
    resource: budget.resource,
    runner: Math.max(budget.minimumRunner, Math.max(1, maximumConcurrency) * budget.perSlot),
    windowMs: RUNNER_PROTOCOL_RATE_WINDOW_MS,
  };
}
