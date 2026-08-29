import { describe, expect, it } from "vitest";

import { combinedLdapFailure, ldapDiagnostic } from "./ldap-diagnostics";

describe("LDAP diagnostics", () => {
  it.each([
    ["connect", "ENOTFOUND ldap.internal", "LDAP_DNS_FAILED"],
    ["connect", "certificate has expired", "LDAP_TLS_FAILED"],
    ["connect", "ETIMEDOUT", "LDAP_CONNECTION_TIMEOUT"],
    ["bind", "InvalidCredentialsError resultCode: 49", "LDAP_BIND_REJECTED"],
    ["search", "NoSuchObjectError resultCode: 32", "LDAP_BASE_DN_NOT_FOUND"],
    ["search", "FilterError resultCode: 87", "LDAP_FILTER_INVALID"],
    ["search", "InsufficientAccessRightsError resultCode: 50", "LDAP_READ_FORBIDDEN"],
  ] as const)("maps %s failures to an actionable code", (phase, message, code) => {
    expect(ldapDiagnostic(new Error(message), phase)).toMatchObject({ code });
  });

  it("preserves a common diagnostic and summarizes mixed server failures", () => {
    const dns = ldapDiagnostic(new Error("ENOTFOUND"), "connect");
    expect(combinedLdapFailure([dns, dns])).toMatchObject({ code: "LDAP_DNS_FAILED" });
    const tls = ldapDiagnostic(new Error("certificate expired"), "connect");
    expect(combinedLdapFailure([dns, tls])).toMatchObject({
      code: "LDAP_DIRECTORY_UNAVAILABLE",
      message: expect.stringContaining("LDAP_DNS_FAILED"),
    });
  });

  it("explains when a directory rejects plaintext bind connections", () => {
    expect(
      ldapDiagnostic(
        new Error("0x60 connection closed ECONNRESET"),
        "bind",
        "ldap://ldap.internal:389",
      ),
    ).toMatchObject({
      code: "LDAP_PLAINTEXT_BIND_REJECTED",
      message: expect.stringContaining("ldaps://"),
    });
  });
});
