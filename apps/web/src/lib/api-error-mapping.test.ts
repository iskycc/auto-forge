import { DomainError } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import { mapApiError } from "./api-error-mapping";

describe("API error mapping", () => {
  it("keeps independent log database lock failures separate from business database contention", () => {
    const cause = Object.assign(new Error("log storage lock timeout"), { code: "55P03" });
    expect(
      mapApiError(
        new DomainError("PLATFORM_LOG_DATABASE_UNAVAILABLE", "日志库暂不可用。", { cause }),
        "log-request",
      ),
    ).toMatchObject({
      status: 503,
      body: { error: { code: "PLATFORM_LOG_DATABASE_UNAVAILABLE" } },
    });
  });
  it.each([
    "VERSION_COPY_TARGET_NOT_EMPTY",
    "VERSION_COPY_TARGET_RESERVED",
    "VERSION_COPY_TARGET_INVALID",
  ])("returns a conflict for %s without treating it as a server failure", (code) => {
    expect(
      mapApiError(new DomainError(code, "请选择其他目标版本。"), "copy-request"),
    ).toMatchObject({ status: 409, body: { error: { code, requestId: "copy-request" } } });
  });
  it("returns actionable stored export data validation without classifying it as a server fault", () => {
    const details = { excludedRows: 1 };
    expect(
      mapApiError(
        new DomainError("EXPORT_DATA_INVALID", "排除异常数据后导出。", { details }),
        "export-request",
      ),
    ).toMatchObject({
      status: 422,
      body: { error: { code: "EXPORT_DATA_INVALID", requestId: "export-request", details } },
    });
  });
  it("distinguishes storage snapshot expiry from node unavailability", () => {
    expect(
      mapApiError(
        new DomainError("STORAGE_INVENTORY_SNAPSHOT_EXPIRED", "快照已过期。"),
        "inventory",
      ),
    ).toMatchObject({
      status: 409,
      body: { error: { code: "STORAGE_INVENTORY_SNAPSHOT_EXPIRED" } },
    });
  });
  it.each([
    "PLATFORM_LOG_BUSY",
    "PLATFORM_LOG_TIMEOUT",
    "PLATFORM_LOG_UNAVAILABLE",
    "PLATFORM_BUSY",
  ])("makes %s retryable", (code) => {
    expect(mapApiError(new DomainError(code, "请稍后重试。"), "overload")).toMatchObject({
      status: 503,
      body: { error: { code } },
    });
  });
  it.each([
    "SQLITE_BUSY",
    "SQLITE_BUSY_SNAPSHOT",
    "SQLITE_LOCKED",
    "55P03",
    "40P01",
    "40001",
    "57014",
  ])("maps wrapped database contention %s without exposing diagnostics", (code) => {
    const cause = Object.assign(new Error("private SQL and credentials"), { code });
    const result = mapApiError(new Error("wrapped query", { cause }), "contention");
    expect(result).toMatchObject({ status: 503, body: { error: { code: "PLATFORM_BUSY" } } });
    expect(JSON.stringify(result)).not.toContain("private SQL");
  });
  it.each(["READ_MODEL_PENDING", "READ_MODEL_NODE_UNAVAILABLE"])(
    "keeps %s retryable without presenting it as an invalid request",
    (code) => {
      expect(
        mapApiError(new DomainError(code, "数据暂不可用。"), "snapshot-request"),
      ).toMatchObject({
        status: 503,
        body: { error: { code, requestId: "snapshot-request" } },
      });
    },
  );

  it("distinguishes a cancelled snapshot read from an internal server failure", () => {
    expect(
      mapApiError(
        new DomainError("READ_MODEL_REQUEST_CANCELLED", "数据读取已取消。"),
        "cancel-request",
      ),
    ).toMatchObject({ status: 499, body: { error: { code: "READ_MODEL_REQUEST_CANCELLED" } } });
  });

  it("returns retryable unavailability when the platform time basis expires", () => {
    expect(
      mapApiError(
        new DomainError("PLATFORM_CLOCK_UNAVAILABLE", "统一时间基准不可用。"),
        "clock-request",
      ),
    ).toMatchObject({
      status: 503,
      body: { error: { code: "PLATFORM_CLOCK_UNAVAILABLE", requestId: "clock-request" } },
    });
  });
  it("keeps an LDAP finalization failure actionable while returning a server status", () => {
    const mapped = mapApiError(
      new DomainError(
        "LDAP_LOGIN_FINALIZATION_FAILED",
        "LDAP 身份验证已通过，但平台账号关联或会话创建失败。请联系管理员并提供请求 ID。",
      ),
      "ldap-request-id",
    );

    expect(mapped).toMatchObject({
      status: 500,
      body: {
        error: {
          code: "LDAP_LOGIN_FINALIZATION_FAILED",
          requestId: "ldap-request-id",
        },
      },
    });
  });

  it("reports runtime asset deletion storage failures as server errors", () => {
    for (const code of [
      "RUNTIME_ASSET_DELETE_FAILED",
      "RUNTIME_ASSET_DELETE_INCONSISTENT",
    ] as const) {
      expect(
        mapApiError(new DomainError(code, "对象存储删除失败。"), "storage-request-id"),
      ).toMatchObject({
        status: 500,
        body: { error: { code, requestId: "storage-request-id" } },
      });
    }
  });
});
