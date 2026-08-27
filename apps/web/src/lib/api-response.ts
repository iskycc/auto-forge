import { randomUUID } from "node:crypto";

import { DomainError } from "@autoforge/domain";
import {
  DDT_IMPORT_FILE_BYTES,
  DDT_IMPORT_FILE_LIMIT,
  DDT_IMPORT_TOTAL_BYTES,
} from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { mapApiError } from "./api-error-mapping";
export { logServerError, rejectRateLimited } from "./api-error-mapping";

export type JarUpload = {
  fileName: string;
  content: Uint8Array;
};

export type DdtUpload = JarUpload & { mediaType: string };

type UploadPolicy = {
  missingCode: string;
  missingMessage: string;
  emptyCode: string;
  emptyMessage: string;
  tooLarge(maximumBytes: number): DomainError;
};

const MULTIPART_ENCODING_ALLOWANCE_BYTES = 64 * 1_024;

export async function readJarUpload(request: Request, maxJarBytes: number): Promise<JarUpload> {
  return readBoundedUpload(request, maxJarBytes, {
    missingCode: "FILE_REQUIRED",
    missingMessage: "请选择要上传的 JAR 文件。",
    emptyCode: "EMPTY_JAR",
    emptyMessage: "JAR 文件为空。",
    tooLarge: jarTooLargeError,
  });
}

export async function readDdtUploads(request: Request): Promise<DdtUpload[]> {
  const tooLarge = () =>
    new DomainError("DDT_UPLOAD_TOO_LARGE", "DDT 上传总大小不能超过 512 MiB。");
  rejectOversizedUpload(request, DDT_IMPORT_TOTAL_BYTES, tooLarge);
  const formData = await parseMultipartFormData(request, DDT_IMPORT_TOTAL_BYTES, tooLarge);
  const files = [...formData.getAll("files"), ...formData.getAll("file")].filter(
    (entry): entry is File => entry instanceof File,
  );
  if (files.length === 0) throw new DomainError("DDT_FILE_REQUIRED", "请选择 DDT 表格或 ZIP。");
  if (files.length > DDT_IMPORT_FILE_LIMIT)
    throw new DomainError(
      "DDT_FILE_LIMIT_EXCEEDED",
      `一次最多上传 ${DDT_IMPORT_FILE_LIMIT} 个文件。`,
    );
  let totalBytes = 0;
  const uploads: DdtUpload[] = [];
  for (const file of files) {
    if (file.size === 0) throw new DomainError("DDT_FILE_EMPTY", `文件“${file.name}”为空。`);
    if (file.size > DDT_IMPORT_FILE_BYTES)
      throw new DomainError("DDT_FILE_TOO_LARGE", `文件“${file.name}”超过 128 MiB。`);
    totalBytes += file.size;
    if (totalBytes > DDT_IMPORT_TOTAL_BYTES) throw tooLarge();
    uploads.push({
      fileName: file.name,
      mediaType: file.type || "application/octet-stream",
      content: new Uint8Array(await file.arrayBuffer()),
    });
  }
  return uploads;
}

async function readBoundedUpload(
  request: Request,
  maximumBytes: number,
  policy: UploadPolicy,
): Promise<JarUpload> {
  rejectOversizedUpload(request, maximumBytes, policy.tooLarge);
  const formData = await parseMultipartFormData(request, maximumBytes, policy.tooLarge);
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new DomainError(policy.missingCode, policy.missingMessage);
  }
  if (file.size === 0) {
    throw new DomainError(policy.emptyCode, policy.emptyMessage);
  }
  if (file.size > maximumBytes) {
    throw policy.tooLarge(maximumBytes);
  }
  return {
    fileName: file.name,
    content: new Uint8Array(await file.arrayBuffer()),
  };
}

function rejectOversizedUpload(
  request: Request,
  maximumBytes: number,
  tooLarge: (maximumBytes: number) => DomainError,
): void {
  const contentLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > maximumBytes + MULTIPART_ENCODING_ALLOWANCE_BYTES
  ) {
    throw tooLarge(maximumBytes);
  }
}

async function parseMultipartFormData(
  request: Request,
  maximumBytes: number,
  tooLarge: (maximumBytes: number) => DomainError,
): Promise<FormData> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data")) {
    throw new DomainError("INVALID_MULTIPART", "上传请求必须使用 multipart/form-data。");
  }
  const body = await readBoundedBody(
    request,
    maximumBytes + MULTIPART_ENCODING_ALLOWANCE_BYTES,
    maximumBytes,
    tooLarge,
  );
  try {
    return await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch (error) {
    throw new DomainError("INVALID_MULTIPART", "上传请求不是有效的 multipart/form-data。", {
      cause: error,
    });
  }
}

async function readBoundedBody(
  request: Request,
  maximumRequestBytes: number,
  maximumBytes: number,
  tooLarge: (maximumBytes: number) => DomainError,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!request.body) {
    throw new DomainError("INVALID_MULTIPART", "上传请求缺少 multipart 请求体。");
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumRequestBytes) {
      await reader.cancel();
      throw tooLarge(maximumBytes);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function jarTooLargeError(maxJarBytes: number): DomainError {
  return new DomainError(
    "JAR_TOO_LARGE",
    `JAR 超过 ${Math.floor(maxJarBytes / 1_048_576)} MiB 的导入限制。`,
  );
}

export function apiErrorResponse(error: unknown, requestId: string = randomUUID()): NextResponse {
  const mapped = mapApiError(error, requestId);
  return NextResponse.json(mapped.body, { status: mapped.status });
}

export async function readJsonBody(request: Request, maximumBytes: number): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new DomainError("REQUEST_BODY_TOO_LARGE", "请求体超过允许的大小。");
  }
  if (!request.body) throw new DomainError("INVALID_JSON", "请求体必须是 JSON。");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new DomainError("REQUEST_BODY_TOO_LARGE", "请求体超过允许的大小。");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    throw new DomainError("INVALID_JSON", "请求体必须是有效的 UTF-8 JSON。", { cause: error });
  }
}

export function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}
