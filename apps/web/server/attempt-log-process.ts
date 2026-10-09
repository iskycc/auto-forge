import { createAttemptLogStore, isolatedThreadLogCompression } from "@autoforge/db/sqlite";
import { z } from "zod";
import { isDomainError } from "@autoforge/domain";
import type { LogIoResponse } from "./log-io-pool.ts";

let store: ReturnType<typeof createAttemptLogStore> | undefined;
const readSchema = z
  .object({
    id: z.number().int().positive(),
    method: z.literal("listChunks"),
    args: z.tuple([
      z
        .object({
          batchId: z.string().regex(/^[0-9a-f-]{8,64}$/),
          attemptId: z.string().min(1).max(160),
          stream: z.enum(["stdout", "stderr", "agent"]),
          afterSequence: z.number().int().min(-1),
          limit: z.number().int().min(1).max(500),
          query: z.string().max(256).optional(),
          recordedAfter: z.iso.datetime().optional(),
          recordedBefore: z.iso.datetime().optional(),
        })
        .strict(),
    ]),
  })
  .strict();

process.on("message", (message: unknown) => {
  void respond(message).catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", requestId: "log-read-process", message: "Log read process failed", error: error instanceof Error ? error.message : "Unknown error" })}\n`,
    );
    process.exit(1);
  });
});
process.once("disconnect", () => {
  store?.close();
  process.exit(0);
});

async function respond(message: unknown): Promise<void> {
  if (message && typeof message === "object" && "configuration" in message) {
    if (store) throw new Error("Log reader configuration cannot change.");
    const { directory } = z
      .object({ directory: z.string().min(1) })
      .strict()
      .parse(message.configuration);
    store = createAttemptLogStore(directory, isolatedThreadLogCompression);
    return;
  }
  let id = 0;
  let response: LogIoResponse;
  try {
    const request = readSchema.parse(message);
    id = request.id;
    if (!store) throw new Error("Log reader is not initialized.");
    const input = request.args[0];
    const value = await store.listChunks({
      batchId: input.batchId,
      attemptId: input.attemptId,
      stream: input.stream,
      afterSequence: input.afterSequence,
      limit: input.limit,
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.recordedAfter !== undefined ? { recordedAfter: input.recordedAfter } : {}),
      ...(input.recordedBefore !== undefined ? { recordedBefore: input.recordedBefore } : {}),
    });
    response = { id, ok: true, value };
  } catch (error) {
    response = {
      id,
      ok: false,
      error: {
        message: isDomainError(error) ? error.message : "日志文件读取失败，请稍后重试。",
        ...(isDomainError(error) ? { code: error.code } : {}),
      },
    };
    if (!isDomainError(error))
      process.stderr.write(
        `${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", requestId: `log-read-${id}`, message: "Log read failed", error: error instanceof Error ? error.message : "Unknown log error" })}\n`,
      );
  }
  if (process.connected) process.send?.(response);
}
