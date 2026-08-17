import { randomUUID } from "node:crypto";

import { DomainError, isDomainError } from "@autoforge/domain";
import { isJarInspectionError } from "@autoforge/testng-discovery";
import { NextResponse } from "next/server";
import { ZodError } from "zod";

export type JarUpload = {
  fileName: string;
  content: Uint8Array;
};

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
  if (isDomainError(error) || isJarInspectionError(error)) {
    const status = domainErrorStatus(error.code);
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          requestId,
          ...(isDomainError(error) && error.details !== undefined
            ? { details: error.details }
            : {}),
        },
      },
      { status },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "请求数据校验失败。",
          requestId,
          details: error.issues,
        },
      },
      { status: 400 },
    );
  }
  logServerError(error, requestId);
  return NextResponse.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "服务器处理请求失败。",
        requestId,
      },
    },
    { status: 500 },
  );
}

export function logServerError(
  error: unknown,
  requestId: string,
  message = "API request failed",
): void {
  const diagnostic = error instanceof Error ? error.message : "Unknown server error";
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      message,
      requestId,
      error: redactSecrets(diagnostic),
    })}\n`,
  );
}

function redactSecrets(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1***@")
    .replace(/((?:password|token|secret|authorization)=)[^\s&]+/gi, "$1***");
}

function domainErrorStatus(code: string): number {
  if (code === "REQUEST_BODY_TOO_LARGE" || code === "JAR_TOO_LARGE") return 413;
  if (code === "RATE_LIMITED") return 429;
  if (code === "RUNNER_AGENT_RESOURCE_UNAVAILABLE") return 503;
  if (code === "RUNTIME_ASSET_STORAGE_FULL") return 507;
  if (
    code === "RUNNER_HOST_CONNECTION_FAILED" ||
    code === "RUNNER_HOST_AUTHENTICATION_FAILED" ||
    code === "RUNNER_HOST_DNS_FAILED" ||
    code === "RUNNER_HOST_CONNECTION_REFUSED" ||
    code === "RUNNER_HOST_CONNECTION_TIMEOUT" ||
    code === "RUNNER_HOST_HANDSHAKE_FAILED" ||
    code === "RUNNER_INSTALLATION_FAILED"
  ) {
    return 502;
  }
  if (code === "AUTH_REQUIRED" || code === "AUTHENTICATION_FAILED") return 401;
  if (code === "AUTH_FORBIDDEN" || code === "CSRF_REJECTED") return 403;
  if (code === "AUTH_BOOTSTRAP_REJECTED") return 403;
  if (
    code.endsWith("_CONFLICT") ||
    code === "RUNNER_HOST_KEY_MISMATCH" ||
    code === "ROLE_IN_USE" ||
    code === "LAST_ADMIN_REQUIRED" ||
    code === "CASE_SOURCE_IN_USE" ||
    code === "CASE_SOURCE_SYNC_CANDIDATE_IN_USE" ||
    code === "CASE_SOURCE_AUTHORITATIVE" ||
    code === "CASE_SOURCE_SYNC_STALE" ||
    code === "CASE_SOURCE_NOT_DELETABLE" ||
    code === "RUNNER_NOT_DELETABLE" ||
    code === "RUNNER_UPDATE_NOT_ALLOWED"
  ) {
    return 409;
  }
  if (code.endsWith("_NOT_FOUND")) return 404;
  if (code === "RUNNER_AUTH_REQUIRED" || code === "RUNNER_AUTH_REJECTED") return 401;
  if (code === "RUNNER_BOOTSTRAP_REJECTED") return 403;
  if (code === "RUNNER_DISABLED") return 403;
  if (code === "LEASE_AUTH_REJECTED") return 401;
  if (code === "LEASE_EXPIRED") return 409;
  if (code === "TERMINAL_AUTH_REJECTED") return 401;
  if (code === "TERMINAL_DISABLED" || code === "RUNNER_TERMINAL_DISABLED") return 403;
  return 400;
}

export function rejectRateLimited(allowed: boolean): void {
  if (!allowed) throw new DomainError("RATE_LIMITED", "请求过于频繁，请稍后重试。");
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
