import { describe, expect, it } from "vitest";

import { ldapConfigurationInputSchema, loginInputSchema } from "../src/identity";

const requiredConfiguration = {
  enabled: true,
  urls: ["ldaps://ldap.internal:636"],
  tlsMode: "ldaps" as const,
  bindDn: "cn=service,dc=example,dc=test",
  userBaseDn: "ou=people,dc=example,dc=test",
  userFilter: "(&(objectClass=person)(uid={username}))",
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
