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
  it("keeps certificate verification enabled for existing clients that omit the setting", () => {
    expect(ldapConfigurationInputSchema.parse(requiredConfiguration).verifyTlsCertificate).toBe(
      true,
    );
  });

  it("accepts an explicit certificate-verification opt-out", () => {
    expect(
      ldapConfigurationInputSchema.parse({
        ...requiredConfiguration,
        verifyTlsCertificate: false,
      }).verifyTlsCertificate,
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

  it("keeps older v1 payloads parseable while adopting ddt-insight placeholders", () => {
    expect(
      ldapConfigurationInputSchema.parse({
        enabled: true,
        urls: ["ldaps://ldap.internal:636"],
        tlsMode: "ldaps",
        bindDn: "cn=service,dc=example,dc=test",
        userBaseDn: "ou=people,dc=example,dc=test",
        userFilter: "(uid={username})",
        groupBaseDn: "ou=groups,dc=example,dc=test",
        groupFilter: "(member={userDn})",
        groupMemberAttribute: "memberOf",
      }),
    ).toMatchObject({
      url: "ldaps://ldap.internal:636",
      userFilter: "(uid={{username}})",
      groupSearchBase: "ou=groups,dc=example,dc=test",
      groupSearchFilter: "(member={{userDn}})",
      groupAttribute: "memberOf",
    });
  });

  it("marks historical StartTLS payloads so upgrades cannot silently use plaintext LDAP", () => {
    expect(
      ldapConfigurationInputSchema.parse({
        ...requiredConfiguration,
        url: undefined,
        urls: ["ldap://ldap.internal:636"],
        tlsMode: "starttls",
      }),
    ).toMatchObject({ url: "ldap://ldap.internal:636", legacyStartTls: true });
  });

  it("allows unused optional attributes to be blank but requires a searched Group name", () => {
    expect(
      ldapConfigurationInputSchema.parse({
        ...requiredConfiguration,
        emailAttribute: "",
        groupAttribute: "",
        groupNameAttribute: "",
      }),
    ).toMatchObject({ emailAttribute: "", groupAttribute: "", groupNameAttribute: "" });
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
