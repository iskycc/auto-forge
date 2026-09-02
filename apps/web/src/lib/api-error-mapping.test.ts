import { DomainError } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import { mapApiError } from "./api-error-mapping";

describe("API error mapping", () => {
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
});
