import { bootstrapAdminInputSchema } from "@autoforge/contracts";
import { describe, expect, it } from "vitest";

import { authEntryValidationMessage } from "./auth-entry-validation";

describe("authEntryValidationMessage", () => {
  it("identifies an invalid username instead of returning a generic request error", () => {
    const parsed = bootstrapAdminInputSchema.safeParse({
      bootstrapToken: "a".repeat(32),
      username: "a",
      displayName: "管理员",
      password: "valid-password-1!",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(authEntryValidationMessage(parsed.error.issues)).toContain("用户名");
  });

  it("preserves the actionable password rule", () => {
    const parsed = bootstrapAdminInputSchema.safeParse({
      bootstrapToken: "a".repeat(32),
      username: "admin",
      displayName: "管理员",
      password: "only-letters!",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(authEntryValidationMessage(parsed.error.issues)).toBe("密码：密码必须包含数字。");
  });
});
