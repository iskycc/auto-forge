import { mkdir, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

/** Linux deployment: unlink while open so a crash cannot leave exported data on disk. */
export async function openTemporaryExportFile(rootDirectory: string): Promise<FileHandle> {
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
