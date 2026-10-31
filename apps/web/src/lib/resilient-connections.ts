const REDIS_COMMAND_TIMEOUT_MS = 3000;
const REDIS_RECONNECT_LIMIT = 60;
const REDIS_RECONNECT_BASE_DELAY_MS = 50;
const REDIS_RECONNECT_MAX_DELAY_MS = 1_000;

export const redisRuntimeCommandOptions = {
  disableOfflineQueue: true,
  commandsQueueMaxLength: 128,
  commandOptions: { timeout: REDIS_COMMAND_TIMEOUT_MS },
} as const;

export function redisReconnectDelay(retries: number): number | Error {
  if (!Number.isInteger(retries) || retries < 0) {
    return new Error("Redis reconnect attempt is invalid.");
  }
  if (retries >= REDIS_RECONNECT_LIMIT) {
    return new Error("Redis reconnect limit reached.");
  }
  return Math.min(
    REDIS_RECONNECT_BASE_DELAY_MS * 2 ** Math.min(retries, 5),
    REDIS_RECONNECT_MAX_DELAY_MS,
  );
}

export const natsReconnectOptions = {
  reconnect: true,
  maxReconnectAttempts: 60,
  reconnectTimeWait: 250,
} as const;

/** The driver timeout covers queued commands only; bound reply waiting as well.
 * The original command stays observed and driver queue limits bound in-flight memory.
 */
export function awaitRedisReply<Result>(operation: Promise<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Redis command reply exceeded 3000 ms.")),
      REDIS_COMMAND_TIMEOUT_MS,
    );
    operation.then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (cause: unknown) => {
        clearTimeout(timeout);
        reject(cause);
      },
    );
  });
}
