import { redisReconnectDelay } from "../src/lib/resilient-connections.ts";
import type { LogChunk, LogStreamGateway } from "./log-stream-gateway.ts";

const CHANNEL = "autoforge:logs:v1:live";
const CACHE_PREFIX = "autoforge:logs:v1:recent:";
// This cache is expendable: at most 128 attempts, 256 KiB / 32 frames each,
// with a two-minute TTL. PostgreSQL locations and local files remain authoritative.
const CACHE_AND_PUBLISH = `
local size = string.len(ARGV[1])
if size <= 262144 then
  redis.call('RPUSH', KEYS[1], ARGV[1])
  local bytes = redis.call('INCRBY', KEYS[2], size)
  while bytes > 262144 or redis.call('LLEN', KEYS[1]) > 32 do
    local removed = redis.call('LPOP', KEYS[1])
    if not removed then break end
    bytes = redis.call('DECRBY', KEYS[2], string.len(removed))
  end
  redis.call('EXPIRE', KEYS[1], 120)
  redis.call('EXPIRE', KEYS[2], 120)
  redis.call('ZADD', KEYS[3], ARGV[2], KEYS[1])
  while redis.call('ZCARD', KEYS[3]) > 128 do
    local oldest = redis.call('ZPOPMIN', KEYS[3], 1)
    redis.call('DEL', oldest[1], oldest[1] .. ':bytes')
  end
  redis.call('EXPIRE', KEYS[3], 120)
end
redis.call('PUBLISH', ARGV[3], ARGV[1])
return 1
`;

type Logger = (level: "info" | "warn" | "error", message: string, fields?: object) => void;
type RelayMessage = { schemaVersion: 1; attemptId: string; chunks: LogChunk[] };
type RedisConnection = {
  isReady: boolean;
  isOpen: boolean;
  destroy(): void;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
};

export class LogStreamRelay {
  private publisher?: RedisConnection;
  private subscriber?: RedisConnection;
  private readonly pending = new Set<Promise<unknown>>();

  private constructor(
    private readonly gateway: LogStreamGateway,
    private readonly logger: Logger,
  ) {}

  static async create(input: {
    mode: "lite" | "full";
    redisUrl?: string;
    gateway: LogStreamGateway;
    logger: Logger;
  }): Promise<LogStreamRelay> {
    const relay = new LogStreamRelay(input.gateway, input.logger);
    if (input.mode === "lite") return relay;
    if (!input.redisUrl) throw new Error("Full log relay requires Redis.");
    const { createClient } = await import("redis");
    const publisher = createClient({
      url: input.redisUrl,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 64,
      commandOptions: { timeout: 3000 },
      socket: { connectTimeout: 5000, reconnectStrategy: redisReconnectDelay },
    });
    const subscriber = publisher.duplicate();
    for (const client of [publisher, subscriber])
      client.on("error", (error: Error) =>
        input.logger("warn", "Redis log transport interrupted", { error: error.message }),
      );
    try {
      await Promise.all([publisher.connect(), subscriber.connect()]);
      await subscriber.subscribe(CHANNEL, (payload) => {
        if (Buffer.byteLength(payload) > 3 * 1024 * 1024) return;
        try {
          const message: unknown = JSON.parse(payload);
          if (isRelayMessage(message)) input.gateway.publish(message.attemptId, message.chunks);
        } catch (error) {
          input.logger("warn", "Ignored invalid Redis log frame", {
            error: error instanceof Error ? error.message : "Invalid frame",
          });
        }
      });
      relay.publisher = publisher;
      relay.subscriber = subscriber;
      input.gateway.setReplay((attemptId) => relay.recent(attemptId));
      return relay;
    } catch (error) {
      for (const client of [publisher, subscriber]) if (client.isOpen) client.destroy();
      throw new Error("Unable to initialize Redis live logs.", { cause: error });
    }
  }

  publish(attemptId: string, chunks: LogChunk[]): void {
    const sanitized = chunks;
    if (!this.publisher?.isReady || this.pending.size >= 32) {
      this.gateway.publish(attemptId, sanitized);
      return;
    }
    const key = CACHE_PREFIX + attemptId;
    const operation = this.publisher
      .eval(CACHE_AND_PUBLISH, {
        keys: [key, key + ":bytes", CACHE_PREFIX + "active"],
        arguments: [
          JSON.stringify({ schemaVersion: 1, attemptId, chunks: sanitized }),
          String(Date.now()),
          CHANNEL,
        ],
      })
      .catch((error: unknown) => {
        this.logger("warn", "Live log cache write failed; persisted logs remain available", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        this.gateway.publish(attemptId, sanitized);
      })
      .finally(() => this.pending.delete(operation));
    this.pending.add(operation);
  }

  async recent(attemptId: string): Promise<LogChunk[]> {
    if (!this.publisher?.isReady) return [];
    const frames = await this.publisher.lRange(CACHE_PREFIX + attemptId, 0, 31);
    const chunks: LogChunk[] = [];
    for (const frame of frames) {
      const message: unknown = JSON.parse(frame);
      if (isRelayMessage(message) && message.attemptId === attemptId)
        chunks.push(...message.chunks);
    }
    return chunks;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    for (const client of [this.subscriber, this.publisher]) if (client?.isOpen) client.destroy();
  }
}

function isRelayMessage(value: unknown): value is RelayMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    message.schemaVersion === 1 &&
    typeof message.attemptId === "string" &&
    message.attemptId.length > 0 &&
    message.attemptId.length <= 128 &&
    Array.isArray(message.chunks) &&
    message.chunks.length <= 256 &&
    message.chunks.every(isLogChunk)
  );
}

function isLogChunk(value: unknown): value is LogChunk {
  if (!value || typeof value !== "object") return false;
  const chunk = value as Record<string, unknown>;
  return (
    (chunk.stream === "stdout" || chunk.stream === "stderr" || chunk.stream === "agent") &&
    typeof chunk.sequence === "number" &&
    Number.isSafeInteger(chunk.sequence) &&
    chunk.sequence >= 0 &&
    typeof chunk.content === "string" &&
    chunk.content.length <= 262_144 &&
    typeof chunk.recordedAt === "string" &&
    chunk.recordedAt.length <= 64 &&
    Number.isFinite(Date.parse(chunk.recordedAt))
  );
}
