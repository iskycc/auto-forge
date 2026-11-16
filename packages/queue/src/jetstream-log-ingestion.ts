import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { JarObjectStorePort, LogIngestionPort } from "@autoforge/application";
import {
  logIngestionMessageSchema,
  logIngestionPayloadSchema,
  logIngestionReceiptSchema,
  type LogIngestionPayload,
  type LogIngestionReceipt,
} from "@autoforge/contracts";
import { DomainError, isDomainError } from "@autoforge/domain";
import {
  AckPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  nanos,
  type Consumer,
  type JsMsg,
  type NatsConnection,
  type Subscription,
} from "nats";

const STAGING_PREFIX = "log-ingestion/v1/";
const MAXIMUM_STAGED_BYTES = 4 * 1024 * 1024;
const MAXIMUM_PENDING_UPLOADS = 256;
const MAXIMUM_PENDING_BYTES = 64 * 1024 * 1024;
const MAXIMUM_DELIVERIES = 8;
// Return a retryable response before the Agent's five-second live-upload wait.
const CONFIRMATION_TIMEOUT_MS = 4_000;
const MAXIMUM_MESSAGE_AGE_MS = 5 * 60_000;
const STAGING_RETENTION_MS = 15 * 60_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
type Watermarks = { stdout: number; stderr: number; agent: number };
type PendingUpload = { resolve(receipt: LogIngestionReceipt): void };
type LogIngestionOptions = {
  connection: NatsConnection;
  objects: JarObjectStorePort;
  persist(input: LogIngestionPayload): Promise<Watermarks>;
  reportError(error: unknown): void;
  namespace?: string;
  concurrency?: number;
  confirmationTimeoutMs?: number;
};

/** Separate durable queue; HTTP acknowledges only committed log-database watermarks. */
export class JetStreamLogIngestion implements LogIngestionPort {
  private readonly pending = new Map<string, PendingUpload>();
  private readonly shutdown = new AbortController();
  private readonly instanceId = randomUUID();
  private readonly subscription: Subscription;
  private readonly consumption: Promise<void>;
  private readonly collection: Promise<void>;
  private uploadsInProgress = 0;
  private pendingBytes = 0;

  private constructor(
    private readonly options: LogIngestionOptions,
    private readonly consumer: Consumer,
    private readonly subject: string,
  ) {
    this.subscription = options.connection.subscribe(
      `autoforge.logs.v1.reply.${this.instanceId}.*`,
      {
        callback: (error, message) => {
          if (error) {
            options.reportError(error);
            return;
          }
          if (message.data.byteLength > 8_192) return;
          try {
            const receipt = logIngestionReceiptSchema.parse(
              JSON.parse(decoder.decode(message.data)),
            );
            this.pending.get(receipt.messageId)?.resolve(receipt);
          } catch (cause) {
            options.reportError(new Error("Invalid log persistence receipt.", { cause }));
          }
        },
      },
    );
    this.consumption = this.consume();
    this.collection = this.collectAbandonedObjects();
  }

  static async create(options: LogIngestionOptions) {
    const namespace = options.namespace ?? "platform";
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(namespace)) throw new Error("Invalid log queue namespace.");
    if (
      options.concurrency !== undefined &&
      (!Number.isInteger(options.concurrency) ||
        options.concurrency < 1 ||
        options.concurrency > 32)
    )
      throw new Error("Log consumer concurrency must be between 1 and 32.");
    const stream = `AUTOFORGE_LOG_INGESTION_V1_${namespace.toUpperCase()}`;
    const subject = `autoforge.logs.v1.ingest.${namespace}`;
    const streamLimits = {
      max_bytes: 64 * 1024 * 1024,
      max_age: nanos(MAXIMUM_MESSAGE_AGE_MS),
      max_msg_size: 4_096,
      duplicate_window: nanos(60_000),
    };
    const manager = await options.connection.jetstreamManager();
    try {
      await manager.streams.info(stream);
    } catch (error) {
      if (!isMissingStream(error)) throw error;
      try {
        await manager.streams.add({
          name: stream,
          subjects: [subject],
          retention: RetentionPolicy.Workqueue,
          storage: StorageType.File,
          discard: DiscardPolicy.New,
          ...streamLimits,
        });
      } catch (cause) {
        // Another Web/Worker can create the same stream during startup.
        await manager.streams.info(stream).catch(() => {
          throw cause;
        });
      }
    }
    const stored = await manager.streams.info(stream);
    if (
      stored.config.storage !== StorageType.File ||
      stored.config.retention !== RetentionPolicy.Workqueue ||
      stored.config.discard !== DiscardPolicy.New ||
      stored.config.subjects?.length !== 1 ||
      stored.config.subjects[0] !== subject
    )
      throw new Error(`JetStream log stream ${stream} has incompatible persistent configuration.`);
    // Keep mutable capacity/retention settings versioned while preserving the
    // operator's replica count and any stricter message-count ceiling.
    await manager.streams.update(stream, streamLimits);
    const durable = "autoforge-log-writer-v1";
    await manager.consumers.add(stream, {
      durable_name: durable,
      filter_subject: subject,
      ack_policy: AckPolicy.Explicit,
      ack_wait: nanos(10_000),
      max_deliver: MAXIMUM_DELIVERIES,
      max_ack_pending: 256,
      max_waiting: 128,
      max_batch: 32,
      max_expires: nanos(2_000),
    });
    const consumer = await options.connection.jetstream().consumers.get(stream, durable);
    return new JetStreamLogIngestion(options, consumer, subject);
  }

  async persist(input: LogIngestionPayload): Promise<Watermarks> {
    if (
      this.shutdown.signal.aborted ||
      this.options.connection.isClosed() ||
      this.uploadsInProgress >= MAXIMUM_PENDING_UPLOADS
    )
      throw logWriterBusy();
    this.uploadsInProgress++;
    const messageId = randomUUID();
    const transfer = new AbortController();
    const receipt = new Promise<LogIngestionReceipt>((resolve) => {
      this.pending.set(messageId, { resolve });
    });
    const timeout = setTimeout(() => {
      transfer.abort();
      this.pending
        .get(messageId)
        ?.resolve({ schemaVersion: 1, messageId, status: "rejected", code: "PLATFORM_LOG_BUSY" });
    }, this.options.confirmationTimeoutMs ?? CONFIRMATION_TIMEOUT_MS);
    try {
      return await Promise.race([
        this.stageAndWaitForReceipt(input, messageId, transfer.signal, receipt),
        receipt.then(persistedWatermarks),
      ]);
    } catch (cause) {
      transfer.abort();
      throw cause;
    } finally {
      clearTimeout(timeout);
      this.pending.delete(messageId);
    }
  }

  private async stageAndWaitForReceipt(
    input: LogIngestionPayload,
    messageId: string,
    transfer: AbortSignal,
    receipt: Promise<LogIngestionReceipt>,
  ): Promise<Watermarks> {
    let stagedBytes = 0;
    try {
      const payload = encoder.encode(JSON.stringify(logIngestionPayloadSchema.parse(input)));
      if (payload.byteLength > MAXIMUM_STAGED_BYTES)
        throw new DomainError("REQUEST_BODY_TOO_LARGE", "日志暂存数据超过允许大小。");
      if (this.pendingBytes + payload.byteLength > MAXIMUM_PENDING_BYTES) throw logWriterBusy();
      stagedBytes = payload.byteLength;
      this.pendingBytes += stagedBytes;
      const sha256 = createHash("sha256").update(payload).digest("hex");
      const objectKey = `${STAGING_PREFIX}${messageId}.json`;
      await this.options.objects.putObject({
        objectKey,
        sha256,
        sizeBytes: payload.byteLength,
        mediaType: "application/json",
        content: oneChunk(payload),
      });
      if (this.shutdown.signal.aborted || transfer.aborted) {
        // No reference was published, so a late staging write can be removed.
        try {
          await this.options.objects.delete(objectKey);
        } catch (cause) {
          this.options.reportError(new Error("Expired log staging cleanup failed.", { cause }));
        }
        throw logWriterBusy();
      }
      const message = logIngestionMessageSchema.parse({
        schemaVersion: 1,
        messageId,
        runId: input.runId,
        attemptId: input.attemptId,
        attempt: 1,
        createdAt: input.receivedAt,
        objectKey,
        sha256,
        sizeBytes: payload.byteLength,
        replySubject: `autoforge.logs.v1.reply.${this.instanceId}.${messageId}`,
      });
      try {
        await this.options.connection
          .jetstream()
          .publish(this.subject, encoder.encode(JSON.stringify(message)), {
            msgID: messageId,
            timeout: 5_000,
          });
      } catch (cause) {
        // A server rejection proves this reference was not accepted. Network
        // timeouts are ambiguous: retain their objects for redelivery/GC.
        if (cause && typeof cause === "object" && "api_error" in cause && cause.api_error) {
          try {
            await this.options.objects.delete(objectKey);
          } catch (cleanup) {
            this.options.reportError(
              new AggregateError([cause, cleanup], "Rejected log staging cleanup failed."),
            );
          }
        }
        throw new DomainError(
          "PLATFORM_LOG_BUSY",
          "日志持久队列暂不可用，请保留本地日志并稍后重传。",
          { cause },
        );
      }
      return persistedWatermarks(await receipt);
    } finally {
      // Retain real I/O reservations even after its HTTP wait times out. A
      // stalled object store must not admit unlimited replacement transfers.
      this.uploadsInProgress--;
      this.pendingBytes -= stagedBytes;
    }
  }

  private async consume() {
    const concurrency = this.options.concurrency ?? 8;
    while (!this.shutdown.signal.aborted) {
      try {
        const messages = await this.consumer.consume({ max_messages: concurrency, expires: 1_000 });
        const stop = () => messages.stop();
        this.shutdown.signal.addEventListener("abort", stop, { once: true });
        const active = new Set<Promise<void>>();
        try {
          for await (const message of messages) {
            if (this.shutdown.signal.aborted) {
              message.nak();
              break;
            }
            while (active.size >= concurrency) await Promise.race(active);
            const persistence = this.process(message).catch((error: unknown) =>
              this.options.reportError(error),
            );
            active.add(persistence);
            // Both branches settle the bookkeeping promise even if a diagnostic
            // reporter itself fails; do not create an unhandled finally chain.
            void persistence.then(
              () => active.delete(persistence),
              () => active.delete(persistence),
            );
          }
        } finally {
          this.shutdown.signal.removeEventListener("abort", stop);
          messages.stop();
          await Promise.all(active);
        }
      } catch (cause) {
        if (this.shutdown.signal.aborted) break;
        this.options.reportError(new Error("Log queue consumption interrupted.", { cause }));
        await delay(1_000, undefined, { signal: this.shutdown.signal }).catch((error: unknown) => {
          if (!this.shutdown.signal.aborted) throw error;
        });
      }
    }
  }

  private async process(delivery: JsMsg) {
    const decoded = logIngestionMessageSchema.safeParse(parseJson(delivery.data));
    if (!decoded.success) {
      delivery.term("invalid log ingestion reference");
      return;
    }
    const message = decoded.data;
    const lease = setInterval(() => delivery.working(), 3_000);
    lease.unref();
    try {
      const source = await this.options.objects.openRead(message.objectKey);
      const bytes = Buffer.alloc(message.sizeBytes);
      let offset = 0;
      for await (const part of source.content) {
        // Throw within the iterator so a rejected source is closed as well.
        if (source.sizeBytes !== message.sizeBytes) throw new Error("Staged log size mismatch.");
        if (offset + part.byteLength > bytes.byteLength)
          throw new Error("Staged log exceeds its size.");
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      if (
        offset !== bytes.byteLength ||
        createHash("sha256").update(bytes).digest("hex") !== message.sha256
      )
        throw new Error("Staged log checksum mismatch.");
      const payload = logIngestionPayloadSchema.parse(parseJson(bytes));
      if (payload.attemptId !== message.attemptId || payload.runId !== message.runId)
        throw new Error("Staged log execution mismatch.");
      const watermarks = await this.options.persist(payload);
      // Database commit and authoritative watermarks precede both acknowledgements.
      try {
        this.reply(
          { schemaVersion: 1, messageId: message.messageId, status: "persisted", watermarks },
          message.replySubject,
        );
        if (await delivery.ackAck({ timeout: 5_000 }))
          await this.options.objects.delete(message.objectKey);
      } catch (cause) {
        // Persistence already succeeded. Redelivery repairs a lost reply/ack;
        // cleanup cannot reverse the committed log result.
        this.options.reportError(
          new Error("Persisted log acknowledgement or staging cleanup failed.", { cause }),
        );
      }
    } catch (cause) {
      const code = rejectionCode(cause);
      if (code === "PLATFORM_LOG_BUSY" && delivery.info.deliveryCount < MAXIMUM_DELIVERIES) {
        delivery.nak(Math.min(2_000, 100 * 2 ** Math.min(4, delivery.info.deliveryCount - 1)));
      } else {
        this.reply(
          { schemaVersion: 1, messageId: message.messageId, status: "rejected", code },
          message.replySubject,
        );
        delivery.term("log persistence rejected; Agent retains unacknowledged logs");
        this.options.reportError(new Error(`Log persistence failed (${code}).`, { cause }));
      }
    } finally {
      clearInterval(lease);
    }
  }

  private reply(receipt: LogIngestionReceipt, subject: string) {
    this.options.connection.publish(subject, encoder.encode(JSON.stringify(receipt)));
  }

  private async collectAbandonedObjects() {
    let cursor: string | undefined;
    while (!this.shutdown.signal.aborted) {
      try {
        await delay(30_000, undefined, { signal: this.shutdown.signal });
        for (let page = 0; page < 10 && !this.shutdown.signal.aborted; page++) {
          const objects = await this.options.objects.list({
            prefix: STAGING_PREFIX,
            limit: 200,
            ...(cursor ? { cursor } : {}),
          });
          for (const object of objects.items) {
            if (Date.parse(object.lastModified) < Date.now() - STAGING_RETENTION_MS)
              await this.options.objects.delete(object.objectKey);
          }
          cursor = objects.nextCursor;
          if (!cursor) break;
        }
      } catch (cause) {
        if (this.shutdown.signal.aborted) break;
        this.options.reportError(new Error("Log staging cleanup deferred.", { cause }));
      }
    }
  }

  async close() {
    this.shutdown.abort();
    for (const [messageId, request] of this.pending)
      request.resolve({
        schemaVersion: 1,
        messageId,
        status: "rejected",
        code: "PLATFORM_LOG_BUSY",
      });
    await Promise.all([this.consumption, this.collection]);
    this.subscription.unsubscribe();
  }
}

async function* oneChunk(bytes: Uint8Array) {
  yield bytes;
}
function persistedWatermarks(result: LogIngestionReceipt): Watermarks {
  if (result.status === "persisted") return result.watermarks;
  throw new DomainError(
    result.code,
    result.code === "PLATFORM_LOG_BUSY"
      ? "日志尚未完成持久化，请保留本地日志并重传。"
      : "日志写入被拒绝，请检查日志序号、时间及执行归属。",
  );
}
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
}
function logWriterBusy() {
  return new DomainError("PLATFORM_LOG_BUSY", "日志接收通道繁忙，请保留本地日志并稍后重传。");
}
function isMissingStream(error: unknown) {
  return error !== null && typeof error === "object" && "code" in error && error.code === "404";
}
function rejectionCode(
  error: unknown,
): Extract<LogIngestionReceipt, { status: "rejected" }>["code"] {
  if (
    isDomainError(error) &&
    [
      "LOG_CHUNK_CONFLICT",
      "LOG_CHUNK_TIME_INVALID",
      "RUN_ATTEMPT_NOT_FOUND",
      "RUN_BATCH_NOT_FOUND",
      "LOG_ARCHIVE_READ_ONLY",
      "FULL_LOCAL_LOG_WRITE_DISABLED",
      "LOG_DAILY_SERVER_REQUIRED",
      "LOG_CHUNK_TOO_LARGE",
      "LOG_CHUNKS_TOO_LARGE",
    ].includes(error.code)
  )
    return error.code as Extract<LogIngestionReceipt, { status: "rejected" }>["code"];
  return "PLATFORM_LOG_BUSY";
}
