import "server-only";

import { exportValidationReportSchema, type ExportValidationReport } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import type { FileHandle } from "node:fs/promises";
import { openTemporaryExportFile } from "./export-temporary-file";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import {
  createRunBatchExportWorkbookStream,
  type RunBatchExportWorkbookInput,
} from "./run-batch-export-xlsx";

export type PreparedRunBatchExportFile = {
  file: FileHandle;
  sizeBytes: number;
  validation: ExportValidationReport;
};

/** Finish and validate the ZIP before sending HTTP headers; rows remain paged and committed. */
export async function prepareRunBatchExportFile(
  pages: AsyncIterable<RunBatchExportWorkbookInput>,
  signal: AbortSignal,
  options: { directory: string; invalidRows?: "reject" | "exclude" },
): Promise<PreparedRunBatchExportFile> {
  signal.throwIfAborted();
  const file = await openTemporaryExportFile(options.directory);
  let completion: Promise<Error | undefined> | undefined;
  try {
    const workbook = await createRunBatchExportWorkbookStream(pages, signal, {
      invalidRows: "exclude",
    });
    completion = workbook.completed;
    // FileHandle write streams retain an extra handle reference when autoClose=false.
    // A bounded Writable leaves one owner and closes cleanly on every failure path.
    const destination = new Writable({
      highWaterMark: 256 * 1024,
      write(chunk: Buffer, _encoding, complete) {
        void file.writeFile(chunk).then(
          () => complete(),
          (cause: unknown) =>
            complete(cause instanceof Error ? cause : new Error("写入导出文件失败。", { cause })),
        );
      },
    });
    await pipeline(workbook.stream, destination, { signal });
    const finalizationError = await completion;
    if (finalizationError) throw finalizationError;
    signal.throwIfAborted();
    const validation = exportValidationReportSchema.parse(workbook.validation);
    if (validation.excludedRows > 0 && options.invalidRows !== "exclude") {
      throw new DomainError(
        "EXPORT_DATA_INVALID",
        "部分记录无法安全写入 Excel，请查看异常数据并排除后导出。",
        { details: validation },
      );
    }
    const sizeBytes = (await file.stat()).size;
    return { file, sizeBytes, validation };
  } catch (cause) {
    const finalizationError = await completion;
    const failure =
      finalizationError && finalizationError !== cause
        ? new AggregateError([cause, finalizationError], "导出生成及清理失败。")
        : cause;
    try {
      await file.close();
    } catch (cleanupError) {
      throw new AggregateError([failure, cleanupError], "导出失败且暂存文件关闭失败。");
    }
    throw failure;
  }
}

/** Read ownership transfers to the stream; end, client cancellation and errors all close the file. */
export function readRunBatchExportFile(prepared: { file: FileHandle }, signal: AbortSignal) {
  const stream = prepared.file.createReadStream({ start: 0, autoClose: true });
  const abort = () =>
    stream.destroy(signal.reason instanceof Error ? signal.reason : new Error("导出下载已取消。"));
  signal.addEventListener("abort", abort, { once: true });
  stream.once("close", () => signal.removeEventListener("abort", abort));
  if (signal.aborted) abort();
  return stream;
}
