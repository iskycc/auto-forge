import { randomUUID } from "node:crypto";

import { DomainError } from "@autoforge/domain";
import { JarInspectionError } from "@autoforge/testng-discovery";
import { NextResponse } from "next/server";
import { ZodError } from "zod";

export type JarUpload = {
  fileName: string;
  content: Uint8Array;
};

export async function readJarUpload(request: Request, maxJarBytes: number): Promise<JarUpload> {
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new DomainError("FILE_REQUIRED", "请选择要上传的 JAR 文件。");
  }
  if (file.size === 0) {
    throw new DomainError("EMPTY_JAR", "JAR 文件为空。");
  }
  if (file.size > maxJarBytes) {
    throw new DomainError("JAR_TOO_LARGE", `JAR 超过 ${maxJarBytes} 字节的导入限制。`);
  }
  return {
    fileName: file.name,
    content: new Uint8Array(await file.arrayBuffer()),
  };
}

export function apiErrorResponse(error: unknown, requestId: string = randomUUID()): NextResponse {
  if (error instanceof DomainError || error instanceof JarInspectionError) {
    const status = domainErrorStatus(error.code);
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          requestId,
          ...(error instanceof DomainError && error.details !== undefined
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
  if (code === "REQUEST_BODY_TOO_LARGE") return 413;
  if (code === "RATE_LIMITED") return 429;
  if (code === "AUTH_REQUIRED" || code === "AUTHENTICATION_FAILED") return 401;
  if (code === "AUTH_FORBIDDEN" || code === "CSRF_REJECTED") return 403;
  if (code === "AUTH_BOOTSTRAP_REJECTED") return 403;
  if (code.endsWith("_CONFLICT") || code === "ROLE_IN_USE" || code === "LAST_ADMIN_REQUIRED") {
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
