import { describe, expect, it } from "vitest";

import {
  ApiClientError,
  isConcurrentModificationError,
  readApiError,
  readApiErrorMessage,
} from "./client-api";

describe("readApiErrorMessage", () => {
  it("leaves a successful response body available to its caller", async () => {
    const response = Response.json({ id: "asset-1" });

    await expect(readApiErrorMessage(response, "保存失败。")).resolves.toBeUndefined();
    await expect(response.json()).resolves.toEqual({ id: "asset-1" });
  });
});

describe("structured client API errors", () => {
  it("preserves the machine code needed for concurrent-modification feedback", async () => {
    const response = Response.json(
      {
        error: {
          code: "CASE_SUITE_REVISION_CONFLICT",
          message: "用例任务已被他人修改，请刷新后重试。",
          requestId: "request-1",
        },
      },
      { status: 409 },
    );

    const error = await readApiError(response, "保存失败。");

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      code: "CASE_SUITE_REVISION_CONFLICT",
      message: "用例任务已被他人修改，请刷新后重试。",
      requestId: "request-1",
      status: 409,
    });
    expect(isConcurrentModificationError(error)).toBe(true);
  });

  it("does not treat name and ordinary HTTP conflicts as stale edits", async () => {
    const nameConflict = new ApiClientError({
      code: "WEBHOOK_NAME_CONFLICT",
      message: "名称重复。",
      status: 409,
    });
    const fallback = await readApiError(new Response("bad gateway", { status: 502 }), "请求失败。");

    expect(isConcurrentModificationError(nameConflict)).toBe(false);
    expect(isConcurrentModificationError(fallback)).toBe(false);
    expect(fallback).toMatchObject({ code: "HTTP_REQUEST_FAILED", status: 502 });
  });
});
