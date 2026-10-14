import "server-only";

import { exportValidationReportSchema, type ExportValidationReport } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { mkdir, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import {
  createRunBatchExportWorkbookStream,
  type RunBatchExportWorkbookInput,
} from "./run-batch-export-xlsx";

export type PreparedRunBatchExportFile = {
  file: FileHandle;
  filename: string;
  sizeBytes: number;
  validation: ExportValidationReport;
};

/** Linux deployment: unlink while open so a crash cannot leave exported data on disk. */
async function openExportFile(rootDirectory: string): Promise<FileHandle> {
  await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(rootDirectory, "autoforge-export-"));
  let file: FileHandle | undefined;
  try {
    file = await open(join(directory, "workbook.xlsx"), "wx+", 0o600);
    await rm(directory, { recursive: true, force: true });
    return file;
  } catch (cause) {
    const cleanup = await Promise.allSettled([
      ...(file ? [file.close()] : []),
      rm(directory, { recursive: true, force: true }),
    ]);
    const cleanupErrors = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (cleanupErrors.length)
      throw new AggregateError([cause, ...cleanupErrors], "创建导出暂存文件失败，清理未完成。");
    throw cause;
  }
}

/** Finish and validate the ZIP before sending HTTP headers; rows remain paged and committed. */
export async function prepareRunBatchExportFile(
  pages: AsyncIterable<RunBatchExportWorkbookInput>,
  signal: AbortSignal,
  options: { directory: string; invalidRows?: "reject" | "exclude" },
): Promise<PreparedRunBatchExportFile> {
  signal.throwIfAborted();
  const file = await openExportFile(options.directory);
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
    return { file, filename: workbook.filename, sizeBytes, validation };
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
export function readRunBatchExportFile(prepared: PreparedRunBatchExportFile, signal: AbortSignal) {
  const stream = prepared.file.createReadStream({ start: 0, autoClose: true });
  const abort = () =>
    stream.destroy(signal.reason instanceof Error ? signal.reason : new Error("导出下载已取消。"));
  signal.addEventListener("abort", abort, { once: true });
  stream.once("close", () => signal.removeEventListener("abort", abort));
  if (signal.aborted) abort();
  return stream;
}
