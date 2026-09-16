import { createUserInputSchema } from "@autoforge/contracts";
import { describe, expect, it } from "vitest";

import { userCreationValidationErrors } from "./user-creation-validation";

describe("user creation validation feedback", () => {
  it("groups every failed rule by field without repeating the field or the same reason", () => {
    const parsed = createUserInputSchema.safeParse({
      username: "ab",
      displayName: " ",
      email: "invalid",
      password: "OnlyLettersHere",
    });
    if (parsed.success) throw new Error("Expected invalid user input to be rejected.");
    const errors = userCreationValidationErrors([...parsed.error.issues, ...parsed.error.issues]);
    expect(errors).toEqual([
      { field: "username", message: "用户名：用户名至少需要 3 个字符。" },
      { field: "displayName", message: "显示名称：请输入显示名称。" },
      { field: "email", message: "邮箱：请输入有效的邮箱地址，例如 name@example.com。" },
      { field: "password", message: "初始密码：密码必须包含数字。 密码必须包含特殊字符。" },
    ]);
    expect(JSON.stringify(errors)).not.toContain("OnlyLettersHere");
  });

  it("ignores malformed or unrelated API details while retaining recognized field errors", () => {
    expect(userCreationValidationErrors({ message: "unavailable" })).toEqual([]);
    expect(
      userCreationValidationErrors([
        null,
        {},
        { path: null },
        { path: "password", message: "invalid" },
        { path: ["unknown"], message: "invalid" },
        { path: ["password"], message: 123 },
        { path: ["password"], message: " " },
        { path: ["username"], message: " 用户名已存在。 " },
      ]),
    ).toEqual([{ field: "username", message: "用户名：用户名已存在。" }]);
  });
});
