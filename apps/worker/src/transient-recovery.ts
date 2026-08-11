import type { WorkerLogger } from "@autoforge/application";

type RecoveryOptions = {
  operationName: string;
  maximumConsecutiveFailures?: number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
  stableRunResetMs?: number;
  now?: () => number;
};

export async function runWithTransientRecovery(
  signal: AbortSignal,
  operation: () => Promise<void>,
  logger: WorkerLogger,
  options: RecoveryOptions,
): Promise<void> {
  const maximumConsecutiveFailures = options.maximumConsecutiveFailures ?? 60;
  const initialDelayMs = options.initialDelayMs ?? 250;
  const maximumDelayMs = options.maximumDelayMs ?? 5_000;
  const stableRunResetMs = options.stableRunResetMs ?? 30_000;
  const now = options.now ?? Date.now;
  validateOptions(maximumConsecutiveFailures, initialDelayMs, maximumDelayMs, stableRunResetMs);

  let consecutiveFailures = 0;
  while (!signal.aborted) {
    const startedAt = now();
    try {
      await operation();
      if (!signal.aborted) {
        throw new Error(`${options.operationName} stopped unexpectedly.`);
      }
    } catch (error) {
      if (signal.aborted) return;
      if (now() - startedAt >= stableRunResetMs) consecutiveFailures = 0;
      consecutiveFailures += 1;
      if (consecutiveFailures >= maximumConsecutiveFailures) {
        throw new Error(`${options.operationName} exceeded its transient recovery limit.`, {
          cause: error,
        });
      }
      const delayMs = Math.min(
        maximumDelayMs,
        initialDelayMs * 2 ** Math.min(consecutiveFailures - 1, 5),
      );
      logger.error(`${options.operationName} temporarily unavailable`, {
        consecutiveFailures,
        retryDelayMs: delayMs,
        error: error instanceof Error ? error.message : "unknown error",
      });
      await abortableDelay(signal, delayMs);
    }
  }
}

function validateOptions(
  maximumConsecutiveFailures: number,
  initialDelayMs: number,
  maximumDelayMs: number,
  stableRunResetMs: number,
): void {
  if (!Number.isInteger(maximumConsecutiveFailures) || maximumConsecutiveFailures < 2) {
    throw new Error("Recovery failure limit must be at least two.");
  }
  if (
    !Number.isInteger(initialDelayMs) ||
    initialDelayMs < 1 ||
    !Number.isInteger(maximumDelayMs) ||
    maximumDelayMs < initialDelayMs ||
    !Number.isInteger(stableRunResetMs) ||
    stableRunResetMs < 1
  ) {
    throw new Error("Recovery timing options are invalid.");
  }
}

function abortableDelay(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}
