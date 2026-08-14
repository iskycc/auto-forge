import type { NatsConnection, Subscription } from "nats";

import { natsReconnectOptions } from "../src/lib/resilient-connections.ts";
import type { LogChunk, LogStreamGateway } from "./log-stream-gateway.ts";

const LIVE_LOG_SUBJECT = "autoforge.logs.v1.live";
const MAXIMUM_RELAY_MESSAGE_BYTES = 900 * 1024;

type Logger = (level: "info" | "warn" | "error", message: string, fields?: object) => void;
type RelayMessage = {
  schemaVersion: 1;
  attemptId: string;
  chunks: LogChunk[];
};

export class LogStreamRelay {
  private connection?: NatsConnection;
  private subscription?: Subscription;
  private consumeTask?: Promise<void>;
  private encode?: (message: RelayMessage) => Uint8Array;
  private decode?: (payload: Uint8Array) => RelayMessage;

  private constructor(
    private readonly gateway: LogStreamGateway,
    private readonly logger: Logger,
  ) {}

  static async create(input: {
    mode: "lite" | "full";
    natsServers?: string[];
    gateway: LogStreamGateway;
    logger: Logger;
  }): Promise<LogStreamRelay> {
    const relay = new LogStreamRelay(input.gateway, input.logger);
    if (input.mode === "lite") return relay;
    if (!input.natsServers?.length) throw new Error("Full log relay requires NATS servers.");
    const { connect, JSONCodec } = await import("nats");
    const connection = await connect({
      servers: input.natsServers,
      timeout: 5_000,
      ...natsReconnectOptions,
    });
    const codec = JSONCodec<RelayMessage>();
    relay.connection = connection;
    relay.encode = (message) => codec.encode(message);
    relay.decode = (payload) => codec.decode(payload);
    relay.subscription = connection.subscribe(LIVE_LOG_SUBJECT);
    relay.consumeTask = relay.consume(relay.subscription);
    return relay;
  }

  publish(attemptId: string, chunks: LogChunk[]): void {
    if (!this.connection || !this.encode) {
      this.gateway.publish(attemptId, chunks);
      return;
    }
    for (const chunk of chunks) {
      try {
        const message = this.encode({ schemaVersion: 1, attemptId, chunks: [chunk] });
        if (message.byteLength > MAXIMUM_RELAY_MESSAGE_BYTES) {
          this.logger("warn", "Live log chunk exceeds the cross-replica relay limit", {
            attemptId,
            sequence: chunk.sequence,
            stream: chunk.stream,
            sizeBytes: message.byteLength,
          });
          this.gateway.publish(attemptId, [chunk]);
          continue;
        }
        this.connection.publish(LIVE_LOG_SUBJECT, message);
      } catch (error) {
        this.logger("warn", "Live log relay publish failed", {
          attemptId,
          sequence: chunk.sequence,
          stream: chunk.stream,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        this.gateway.publish(attemptId, [chunk]);
      }
    }
  }

  async close(): Promise<void> {
    if (!this.connection) return;
    await this.connection.drain();
    await this.consumeTask;
  }

  private async consume(subscription: Subscription): Promise<void> {
    try {
      for await (const message of subscription) {
        try {
          const decoded = this.decode?.(message.data);
          if (!isRelayMessage(decoded)) {
            this.logger("warn", "Ignored an invalid live log relay message");
            continue;
          }
          this.gateway.publish(decoded.attemptId, decoded.chunks);
        } catch (error) {
          this.logger("warn", "Ignored an unreadable live log relay message", {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
    } catch (error) {
      this.logger("error", "Live log relay subscription stopped", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
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
    message.chunks.length === 1 &&
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
