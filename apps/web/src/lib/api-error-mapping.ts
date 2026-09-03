import { DomainError, isDomainError } from "@autoforge/domain";
import { isJarInspectionError } from "@autoforge/testng-discovery";
import { ZodError } from "zod";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

export interface MappedApiError {
  status: number;
  body: ApiErrorBody;
}

/**
 * 将应用层异常映射为稳定的 API 错误载荷。框架无关：Route Handler 经
 * apiErrorResponse 包装为 NextResponse，控制面快路径直接写入原始 HTTP 响应，
 * 两者必须产出完全一致的状态码与错误结构。
 */
export function mapApiError(error: unknown, requestId: string): MappedApiError {
  if (isDomainError(error) || isJarInspectionError(error)) {
    return {
      status: domainErrorStatus(error.code),
      body: {
        error: {
          code: error.code,
          message: error.message,
          requestId,
          ...(isDomainError(error) && error.details !== undefined
            ? { details: error.details }
            : {}),
        },
      },
    };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: "VALIDATION_FAILED",
          message: "请求数据校验失败。",
          requestId,
          details: error.issues,
        },
      },
    };
  }
  logServerError(error, requestId);
  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: "服务器处理请求失败。",
        requestId,
      },
    },
  };
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
  if (code === "REQUEST_BODY_TOO_LARGE" || code.endsWith("_TOO_LARGE")) return 413;
  if (code === "RATE_LIMITED") return 429;
  if (code === "RUNNER_AGENT_RESOURCE_UNAVAILABLE") return 503;
  if (code === "RUNTIME_ASSET_STORAGE_FULL") return 507;
  if (code === "RUNTIME_ASSET_DELETE_FAILED" || code === "RUNTIME_ASSET_DELETE_INCONSISTENT") {
    return 500;
  }
  if (code === "LDAP_LOGIN_FINALIZATION_FAILED") return 500;
  if (
    code === "RUNNER_HOST_CONNECTION_FAILED" ||
    code === "RUNNER_HOST_AUTHENTICATION_FAILED" ||
    code === "RUNNER_HOST_DNS_FAILED" ||
    code === "RUNNER_HOST_CONNECTION_REFUSED" ||
    code === "RUNNER_HOST_CONNECTION_TIMEOUT" ||
    code === "RUNNER_HOST_HANDSHAKE_FAILED" ||
    code === "RUNNER_INSTALLATION_FAILED" ||
    code === "JENKINS_CONFIGURATION_TEST_FAILED"
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
