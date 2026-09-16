import { describe, expect, it } from "vitest";

import {
  createUserInputSchema,
  ldapConfigurationInputSchema,
  loginInputSchema,
} from "../src/identity";

describe("local user creation validation", () => {
  const validUser = {
    username: "local-user",
    displayName: "本地用户",
    password: "Initial!Password123",
  };

  it.each([
    ["username", "ab", "用户名至少需要 3 个字符。"],
    ["username", "a".repeat(65), "用户名不能超过 64 个字符。"],
    ["username", "测试用户", "用户名须以字母或数字开头，只能包含字母、数字、点、下划线和短横线。"],
    ["displayName", "   ", "请输入显示名称。"],
    ["displayName", "名".repeat(121), "显示名称不能超过 120 个字符。"],
    ["email", "invalid-email", "请输入有效的邮箱地址，例如 name@example.com。"],
    ["email", `${"a".repeat(310)}@example.com`, "邮箱不能超过 320 个字符。"],
    ["password", "Short!123", "密码至少需要 12 个字符。"],
    ["password", `Ab1!${"a".repeat(125)}`, "密码不能超过 128 个字符。"],
    ["password", "1234567890!!", "密码必须包含字母。"],
    ["password", "OnlyLetters!!", "密码必须包含数字。"],
    ["password", "OnlyLetters123", "密码必须包含特殊字符。"],
  ])("explains the rejected %s value without echoing it", (field, value, message) => {
    const result = createUserInputSchema.safeParse({ ...validUser, [field]: value });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected invalid user input to be rejected.");
    expect(result.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: [field], message })]),
    );
    if (field === "password") expect(JSON.stringify(result.error.issues)).not.toContain(value);
  });

  it("preserves normalization, optional email and mandatory initial password change", () => {
    expect(
      createUserInputSchema.parse({
        ...validUser,
        username: " local-user ",
        displayName: " 用户 ",
      }),
    ).toEqual({ ...validUser, displayName: "用户", forcePasswordChange: true });
  });
});

const requiredConfiguration = {
  enabled: true,
  url: "ldaps://ldap.internal:636",
  bindDn: "cn=service,dc=example,dc=test",
  userBaseDn: "ou=people,dc=example,dc=test",
  userFilter: "(&(objectClass=person)(uid={{username}}))",
};

describe("LDAP configuration contracts", () => {
  it("uses the same configurable fields and defaults as ddt-insight", () => {
    expect(ldapConfigurationInputSchema.parse(requiredConfiguration)).toEqual({
      enabled: true,
      url: "ldaps://ldap.internal:636",
      tlsRejectUnauthorized: true,
      connectTimeoutMs: 5_000,
      bindDn: "cn=service,dc=example,dc=test",
      clearBindPassword: false,
      userBaseDn: "ou=people,dc=example,dc=test",
      userFilter: "(&(objectClass=person)(uid={{username}}))",
      displayNameAttribute: "displayName",
      mailAttribute: "mail",
      groupAttribute: "memberOf",
      groupSearchBase: "",
      groupSearchFilter: "(member={{userDn}})",
      groupNameAttribute: "cn",
      defaultRole: "editor",
    });
  });

  it("accepts an explicit certificate-verification opt-out", () => {
    expect(
      ldapConfigurationInputSchema.parse({
        ...requiredConfiguration,
        tlsRejectUnauthorized: false,
      }).tlsRejectUnauthorized,
    ).toBe(false);
  });

  it("normalizes implicit TLS ports and supports anonymous service searches", () => {
    expect(
      ldapConfigurationInputSchema.parse({
        ...requiredConfiguration,
        url: "ldap://ldap.internal:636",
        bindDn: "",
      }),
    ).toMatchObject({
      url: "ldaps://ldap.internal:636",
      bindDn: "",
      groupAttribute: "memberOf",
      groupSearchFilter: "(member={{userDn}})",
      defaultRole: "editor",
    });
  });

  it("rejects legacy server arrays and single-brace placeholders", () => {
    expect(() =>
      ldapConfigurationInputSchema.parse({
        enabled: true,
        urls: ["ldaps://ldap.internal:636"],
        bindDn: "cn=service,dc=example,dc=test",
        userBaseDn: "ou=people,dc=example,dc=test",
        userFilter: "(uid={username})",
      }),
    ).toThrow(/服务地址|用户过滤器/u);
  });

  it("allows unused optional attributes to be blank but requires a searched Group name", () => {
    expect(
      ldapConfigurationInputSchema.parse({
        ...requiredConfiguration,
        mailAttribute: "",
        groupAttribute: "",
        groupNameAttribute: "",
      }),
    ).toMatchObject({ mailAttribute: "", groupAttribute: "", groupNameAttribute: "" });
    expect(() =>
      ldapConfigurationInputSchema.parse({
        ...requiredConfiguration,
        groupSearchBase: "ou=groups,dc=example,dc=test",
        groupNameAttribute: "",
      }),
    ).toThrow(/Group 名称属性/u);
  });
});

describe("login contracts", () => {
  it("accepts a unified LDAP-compatible identifier without a provider selection", () => {
    expect(
      loginInputSchema.parse({ username: "alice@example.test", password: "Directory!123" }),
    ).toEqual({ username: "alice@example.test", password: "Directory!123" });
  });

  it("keeps legacy provider hints parseable during the compatibility window", () => {
    expect(
      loginInputSchema.parse({
        username: "administrator",
        password: "Admin!Password123",
        provider: "ldap",
      }),
    ).toMatchObject({ provider: "ldap" });
  });
});
