import { parentPort, workerData } from "node:worker_threads";
import { createAttemptLogStore, isolatedThreadLogCompression } from "@autoforge/db/sqlite";
import { isDomainError } from "@autoforge/domain";
import { z } from "zod";
import type { LogIoRequest, LogIoResponse } from "./log-io-pool";

const port = parentPort;
if (!port) throw new Error("Log I/O requires a parent port.");
const { directory } = z.object({ directory: z.string().min(1) }).parse(workerData);
const store = createAttemptLogStore(directory, isolatedThreadLogCompression);
const requestSchema = z.object({
  id: z.number().int().positive(),
  method: z.enum([
    "appendChunks",
    "listChunks",
    "acknowledgedSequence",
    "recordWatermarks",
    "removeBatchStore",
    "batchStoreStats",
    "directoryBytes",
  ]),
  args: z.array(z.unknown()).max(3),
}) satisfies z.ZodType<LogIoRequest>;
port.on("message", async (message: unknown) => {
  let responseId = 0;
  try {
    const request = requestSchema.parse(message);
    responseId = request.id;
    const operation = store[request.method] as (...args: unknown[]) => unknown;
    const value = await operation(...request.args);
    port.postMessage({ id: request.id, ok: true, value } satisfies LogIoResponse);
  } catch (error) {
    port.postMessage({
      id: responseId,
      ok: false,
      error: {
        message: isDomainError(error)
          ? error.message
          : "日志文件操作失败，请检查节点磁盘或稍后重试。",
        ...(isDomainError(error) ? { code: error.code } : {}),
      },
    } satisfies LogIoResponse);
    if (!isDomainError(error))
      process.stderr.write(
        `${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", message: "Log disk operation failed", requestId: `log-io-${responseId}`, error: error instanceof Error ? error.message : "Unknown log error" })}\n`,
      );
  }
});
process.once("exit", () => store.close());
