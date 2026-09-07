export type LogIoMethod =
  | "appendChunks"
  | "listChunks"
  | "acknowledgedSequence"
  | "recordWatermarks"
  | "removeBatchStore"
  | "batchStoreStats"
  | "directoryBytes";

export interface LogIoDispatcher {
  call(method: LogIoMethod, args: unknown[]): Promise<unknown>;
}

export const MAX_QUEUED_LOG_BYTES = 16 * 1024 * 1024;

/** Account for UTF-16 strings before cloning payloads into worker message queues. */
export function logPayloadBytes(input: unknown): number {
  if (!input || typeof input !== "object" || !("chunks" in input) || !Array.isArray(input.chunks))
    return 0;
  return input.chunks.reduce(
    (bytes: number, chunk: unknown) =>
      bytes +
      (chunk && typeof chunk === "object" && "content" in chunk && typeof chunk.content === "string"
        ? chunk.content.length * 2
        : 0),
    0,
  );
}

const runtime = globalThis as typeof globalThis & { __autoforgeLogIo?: LogIoDispatcher };

export function registerLogIo(dispatcher: LogIoDispatcher): void {
  runtime.__autoforgeLogIo = dispatcher;
}

export function unregisterLogIo(dispatcher: LogIoDispatcher): void {
  if (runtime.__autoforgeLogIo === dispatcher) delete runtime.__autoforgeLogIo;
}

export function logIoDispatcher(): LogIoDispatcher | undefined {
  return runtime.__autoforgeLogIo;
}
