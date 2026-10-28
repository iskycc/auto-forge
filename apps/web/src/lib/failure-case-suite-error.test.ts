import { describe, expect, it } from "vitest";
import { ApiClientError } from "./client-api";
import { failureCaseSuiteError } from "./failure-case-suite-error";

describe("failure task actionable error feedback", () => {
  it("shows a request field and rule instead of only a generic validation message", () => {
    const error = new ApiClientError({
      code: "VALIDATION_FAILED",
      status: 400,
      message: "请求数据校验失败。",
      requestId: "request-1",
      details: [{ path: ["name"], code: "too_big", maximum: 120, message: "Too big" }],
    });
    expect(failureCaseSuiteError(error, "失败")).toEqual({
      message: "请求数据校验失败。",
      details: ["任务名称：不能超过 120 个字符或条目。"],
      requestId: "request-1",
    });
  });
  it("distinguishes stored batch settings from browser input", () => {
    const error = new ApiClientError({
      code: "CASE_SUITE_EXECUTION_SNAPSHOT_INVALID",
      status: 422,
      message: "执行配置快照校验失败",
      details: {
        source: "batch_snapshot",
        issues: [{ field: "adapter.environmentAddresses.0", message: "配置字段类型不正确。" }],
      },
    });
    expect(failureCaseSuiteError(error, "失败").details).toEqual([
      "执行批次配置快照 · Adapter / 环境 IP / 0：配置字段类型不正确。",
    ]);
  });
  it("keeps missing case identities and caps very large diagnostic lists", () => {
    const error = new ApiClientError({
      code: "CASE_SUITE_FAILURE_MEMBER_UNAVAILABLE",
      status: 400,
      message: "用例不可用",
      details: {
        source: "case_selection",
        issues: Array.from({ length: 30 }, () => ({
          field: "case",
          message: "DDT 用例 case-1 不可用",
        })),
      },
    });
    const result = failureCaseSuiteError(error, "失败");
    expect(result.details).toHaveLength(10);
    expect(result.details[0]).toContain("case-1");
  });
  it("keeps ordinary errors and ignores malformed details", () => {
    expect(failureCaseSuiteError(new Error("权限不足"), "失败")).toEqual({
      message: "权限不足",
      details: [],
    });
    expect(
      failureCaseSuiteError(
        new ApiClientError({
          code: "HTTP_REQUEST_FAILED",
          status: 500,
          message: "失败",
          details: { secrets: "do not display" },
        }),
        "失败",
      ).details,
    ).toEqual([]);
  });
});
