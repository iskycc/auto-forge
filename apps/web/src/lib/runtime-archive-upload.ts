import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import { DomainError, type RuntimeArchiveFormat } from "@autoforge/domain";

export type StagedRuntimeArchive = {
  fileName: string;
  sha256: string;
  sizeBytes: number;
  content: AsyncIterable<Uint8Array>;
  dispose(): Promise<void>;
};

export async function stageRuntimeArchive(
  request: Request,
  archiveFormat: RuntimeArchiveFormat,
  stagingRoot: string,
): Promise<StagedRuntimeArchive> {
  const fileName = runtimeArchiveFileName(request);
  const declaredSize = optionalContentLength(request);
  if (!request.body) {
    throw new DomainError("RUNTIME_ASSET_UPLOAD_INVALID", "运行时资源上传缺少请求体。");
  }

  // 暂存目录必须与对象存储位于同一文件系统，避免 tmpfs 容量限制并保证原子重命名。
  const directory = await createStagingDirectory(stagingRoot);
  const path = join(directory, "archive");
  const file = await open(path, "wx", 0o600).catch(async (cause: unknown) => {
    await rm(directory, { force: true, recursive: true });
    throw asStorageFullError(cause);
  });
  const digest = createHash("sha256");
  const signature: number[] = [];
  let sizeBytes = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (sizeBytes > Number.MAX_SAFE_INTEGER - value.byteLength) {
        await reader.cancel();
        throw new DomainError("RUNTIME_ASSET_UPLOAD_INVALID", "运行时资源大小超出协议范围。");
      }
      sizeBytes += value.byteLength;
      for (let index = 0; index < value.byteLength && signature.length < 2; index += 1) {
        signature.push(value[index]!);
      }
      digest.update(value);
      await writeCompleteChunk(file, value);
    }
    await file.sync();
    await file.close();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await file.close().catch(() => undefined);
    await rm(directory, { force: true, recursive: true });
    throw asStorageFullError(error);
  }

  if (sizeBytes === 0 || (declaredSize !== undefined && declaredSize !== sizeBytes)) {
    await rm(directory, { force: true, recursive: true });
    throw new DomainError("RUNTIME_ASSET_UPLOAD_INVALID", "运行时资源实际大小与请求声明不一致。");
  }
  if (!matchesArchive(fileName, signature, archiveFormat)) {
    await rm(directory, { force: true, recursive: true });
    throw new DomainError(
      "RUNTIME_ASSET_FORMAT_INVALID",
      `上传文件不是有效的 ${archiveFormat} 压缩包或扩展名不匹配。`,
    );
  }

  return {
    fileName,
    sha256: digest.digest("hex"),
    sizeBytes,
    content: createReadStream(path),
    dispose: () => rm(directory, { force: true, recursive: true }),
  };
}

async function createStagingDirectory(stagingRoot: string): Promise<string> {
  try {
    await mkdir(stagingRoot, { recursive: true });
    return await mkdtemp(join(stagingRoot, "autoforge-runtime-upload-"));
  } catch (cause) {
    throw asStorageFullError(cause);
  }
}

// 磁盘写满时给出可诊断的领域错误；其他文件系统错误保留原始 cause 继续抛出。
function asStorageFullError(error: unknown): unknown {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOSPC") {
    return new DomainError(
      "RUNTIME_ASSET_STORAGE_FULL",
      "平台数据目录磁盘空间不足，无法保存上传内容。",
      { cause: error },
    );
  }
  return error;
}

async function writeCompleteChunk(
  file: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten === 0) {
      throw new Error("Runtime archive staging made no write progress.");
    }
    offset += bytesWritten;
  }
}

function runtimeArchiveFileName(request: Request): string {
  const encoded = request.headers.get("x-autoforge-file-name");
  let fileName: string;
  try {
    fileName = decodeURIComponent(encoded ?? "");
  } catch (cause) {
    throw new DomainError("RUNTIME_ASSET_UPLOAD_INVALID", "运行时资源文件名编码无效。", {
      cause,
    });
  }
  if (
    !fileName ||
    fileName.length > 255 ||
    fileName !== basename(fileName) ||
    /[\u0000-\u001f\u007f]/u.test(fileName)
  ) {
    throw new DomainError("RUNTIME_ASSET_UPLOAD_INVALID", "运行时资源文件名无效。");
  }
  return fileName;
}

function optionalContentLength(request: Request): number | undefined {
  const value = request.headers.get("content-length");
  if (value === null) return undefined;
  const sizeBytes = Number(value);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new DomainError("RUNTIME_ASSET_UPLOAD_INVALID", "运行时资源大小声明无效。");
  }
  return sizeBytes;
}

function matchesArchive(
  fileName: string,
  signature: readonly number[],
  archiveFormat: RuntimeArchiveFormat,
): boolean {
  const lowerName = fileName.toLowerCase();
  return archiveFormat === "zip"
    ? lowerName.endsWith(".zip") && signature[0] === 0x50 && signature[1] === 0x4b
    : (lowerName.endsWith(".tar.gz") || lowerName.endsWith(".tgz")) &&
        signature[0] === 0x1f &&
        signature[1] === 0x8b;
}
