import { Zip, ZipDeflate } from "fflate";
import { setImmediate } from "node:timers/promises";
import { toUSVString } from "node:util";
import { DomainError } from "@autoforge/domain";
import { openTemporaryExportFile } from "./export-temporary-file";

export type FailureLogArchiveEntry = { name: string; content: AsyncIterable<string> };
const MAXIMUM_ZIP_BYTES = 0xffffffff;
const MAXIMUM_ZIP_ENTRIES = 65535;
const COMPRESSION_CHUNK_BYTES = 32 * 1024;

/** Flat, bounded Windows/Linux filenames; ordinal distinguishes rounds and sanitized collisions. */
export function failureLogEntryName(identifier: string, round: number, ordinal: number): string {
  const suffix = `__第${round}轮_${ordinal}.log`;
  const normalized = toUSVString(identifier)
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "_")
    .replace(/^[.\s]+|[.\s]+$/gu, "");
  let prefix = "";
  let bytes = Buffer.byteLength(suffix);
  for (const character of normalized || "未命名用例") {
    if (bytes + Buffer.byteLength(character) > 230) break;
    prefix += character;
    bytes += Buffer.byteLength(character);
  }
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(prefix)) prefix = `_${prefix}`;
  return `${prefix}${suffix}`;
}

/** Sequential entries, bounded deflate chunks and disk backpressure keep the Web event loop available. */
export async function prepareFailureLogArchive(
  entries: AsyncIterable<FailureLogArchiveEntry>,
  signal: AbortSignal,
  directory: string,
) {
  signal.throwIfAborted();
  const file = await openTemporaryExportFile(directory);
  let output: Uint8Array[] = [];
  let failure: Error | undefined;
  let completed = false;
  let sizeBytes = 0;
  let entryCount = 0;
  const archive = new Zip((error, chunk, final) => {
    if (error) failure = error;
    else output.push(chunk);
    if (final) completed = true;
  });
  async function flush() {
    signal.throwIfAborted();
    if (failure) throw failure;
    const chunks = output;
    output = [];
    for (const chunk of chunks) {
      sizeBytes += chunk.byteLength;
      if (sizeBytes > MAXIMUM_ZIP_BYTES)
        throw new DomainError("EXPORT_ARCHIVE_TOO_LARGE", "日志压缩包超过 4 GiB，请缩小导出范围。");
      await file.writeFile(chunk);
    }
  }
  try {
    for await (const entry of entries) {
      signal.throwIfAborted();
      if (++entryCount > MAXIMUM_ZIP_ENTRIES)
        throw new DomainError("EXPORT_ARCHIVE_TOO_LARGE", "日志文件过多，请按轮次分别导出。");
      const compressed = new ZipDeflate(entry.name, { level: 1 });
      archive.add(compressed);
      let uncompressedBytes = 0;
      for await (const text of entry.content) {
        const bytes = Buffer.from(text, "utf8");
        uncompressedBytes += bytes.length;
        if (uncompressedBytes > MAXIMUM_ZIP_BYTES)
          throw new DomainError(
            "EXPORT_ARCHIVE_TOO_LARGE",
            "单个用例日志超过 4 GiB，无法导出 ZIP。",
          );
        for (let offset = 0; offset < bytes.length; offset += COMPRESSION_CHUNK_BYTES) {
          signal.throwIfAborted();
          compressed.push(bytes.subarray(offset, offset + COMPRESSION_CHUNK_BYTES));
          await flush();
          await setImmediate(undefined, { signal });
        }
      }
      compressed.push(new Uint8Array(), true);
      await flush();
      await setImmediate(undefined, { signal });
    }
    archive.end();
    await flush();
    if (!completed) throw new Error("日志压缩包未完整生成，请重试导出。");
    return { file, sizeBytes };
  } catch (cause) {
    archive.terminate();
    try {
      await file.close();
    } catch (cleanupError) {
      throw new AggregateError([cause, cleanupError], "日志导出失败且暂存文件关闭失败。");
    }
    throw cause;
  }
}
