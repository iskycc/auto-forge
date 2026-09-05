import { DomainError } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import { mapApiError } from "./api-error-mapping";

describe("API error mapping", () => {
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
