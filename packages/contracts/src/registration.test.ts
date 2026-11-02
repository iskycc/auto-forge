import { expect, it } from "vitest";
import { registerUserInputSchema } from "./identity";

const valid = {
  username: "lan.user",
  displayName: "内网用户",
  password: "LocalUser!Password123",
  confirmPassword: "LocalUser!Password123",
};

it("uses the existing local account password policy and verifies confirmation", () => {
  expect(registerUserInputSchema.parse(valid)).toEqual(valid);
  expect(
    registerUserInputSchema.safeParse({ ...valid, confirmPassword: "different" }).success,
  ).toBe(false);
  expect(
    registerUserInputSchema.safeParse({ ...valid, password: "short", confirmPassword: "short" })
      .success,
  ).toBe(false);
  expect(registerUserInputSchema.safeParse({ ...valid, username: "中文账号" }).success).toBe(false);
});

it.each(["forcePasswordChange", "source", "systemRoleId", "projectId", "status"])(
  "rejects the managed account field %s in public registration",
  (field) => {
    expect(registerUserInputSchema.safeParse({ ...valid, [field]: "admin" }).success).toBe(false);
  },
);
