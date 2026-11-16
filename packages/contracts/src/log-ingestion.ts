import { z } from "zod";
import { logChunkSchema } from "./execution";

export const logIngestionPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  batchId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
  attemptId: z.string().min(1).max(128),
  receivedAt: z.iso.datetime({ offset: true }),
  chunks: z.array(logChunkSchema).min(1).max(256),
});

export const logIngestionMessageSchema = z.object({
  schemaVersion: z.literal(1),
  messageId: z.uuid(),
  runId: z.string().min(1).max(128),
  attemptId: z.string().min(1).max(128),
  attempt: z.literal(1),
  createdAt: z.iso.datetime({ offset: true }),
  objectKey: z.string().regex(/^log-ingestion\/v1\/[a-f0-9-]{36}\.json$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(4 * 1024 * 1024),
  replySubject: z.string().regex(/^autoforge\.logs\.v1\.reply\.[a-f0-9-]{36}\.[a-f0-9-]{36}$/),
});

export const logIngestionReceiptSchema = z.discriminatedUnion("status", [
  z.object({
    schemaVersion: z.literal(1),
    messageId: z.uuid(),
    status: z.literal("persisted"),
    watermarks: z.object({
      stdout: z.number().int().min(-1),
      stderr: z.number().int().min(-1),
      agent: z.number().int().min(-1),
    }),
  }),
  z.object({
    schemaVersion: z.literal(1),
    messageId: z.uuid(),
    status: z.literal("rejected"),
    code: z.enum([
      "LOG_CHUNK_CONFLICT",
      "LOG_CHUNK_TIME_INVALID",
      "RUN_ATTEMPT_NOT_FOUND",
      "RUN_BATCH_NOT_FOUND",
      "LOG_ARCHIVE_READ_ONLY",
      "FULL_LOCAL_LOG_WRITE_DISABLED",
      "LOG_DAILY_SERVER_REQUIRED",
      "LOG_CHUNK_TOO_LARGE",
      "LOG_CHUNKS_TOO_LARGE",
      "PLATFORM_LOG_BUSY",
    ]),
  }),
]);

export type LogIngestionPayload = z.infer<typeof logIngestionPayloadSchema>;
export type LogIngestionMessage = z.infer<typeof logIngestionMessageSchema>;
export type LogIngestionReceipt = z.infer<typeof logIngestionReceiptSchema>;
