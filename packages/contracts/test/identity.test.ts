import { describe, expect, it } from "vitest";

import { ldapConfigurationInputSchema, loginInputSchema } from "../src/identity";

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
