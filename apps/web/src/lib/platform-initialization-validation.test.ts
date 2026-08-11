import { describe, expect, it } from "vitest";

import { platformInitializationValidationMessage } from "./platform-initialization-validation";

describe("platform initialization validation messages", () => {
  it("explains an incomplete bootstrap token", () => {
    expect(
      platformInitializationValidationMessage([
        { code: "too_small", minimum: 32, path: ["bootstrapToken"] },
      ]),
    ).toContain("initial-admin-token");
  });

  it("names an invalid public URL", () => {
    expect(
      platformInitializationValidationMessage([
        {
          code: "invalid_format",
          format: "url",
          path: ["configuration", "web", "publicBaseUrl"],
        },
      ]),
    ).toBe("执行机可访问地址：请输入包含协议的完整 URL，例如 https://autoforge.internal。");
  });
});
