const REDIS_RECONNECT_LIMIT = 60;
const REDIS_RECONNECT_BASE_DELAY_MS = 50;
const REDIS_RECONNECT_MAX_DELAY_MS = 1_000;

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
