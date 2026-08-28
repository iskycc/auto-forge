import type { DirectoryConfiguration } from "@autoforge/application";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { LdapDirectory, ldapConnectionPlan, type LdapConnector } from "./ldap-directory";

const baseConfiguration: DirectoryConfiguration = {
  enabled: true,
  urls: ["ldaps://ldap-a.internal:636", "ldaps://ldap-b.internal:636"],
  tlsMode: "ldaps",
  verifyTlsCertificate: true,
  connectTimeoutMs: 2_000,
  operationTimeoutMs: 5_000,
  pageSize: 250,
  maximumUsers: 5_000,
  synchronizationIntervalMinutes: 30,
  bindDn: "cn=service,dc=example,dc=test",
  bindPassword: "bind-secret",
  userBaseDn: "ou=people,dc=example,dc=test",
  userFilter: "(&(objectClass=person)(uid={username}))",
  userIdAttribute: "entryUUID",
  usernameAttribute: "uid",
  displayNameAttribute: "displayName",
  emailAttribute: "mail",
  groupBaseDn: "ou=groups,dc=example,dc=test",
  groupFilter: "(&(objectClass=groupOfNames)(member={userDn}))",
  groupMemberAttribute: "member",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  version: 1,
};

describe("LDAP directory matrix", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("pins TLS 1.2, validates certificates and carries a private CA for LDAPS and StartTLS", () => {
    const caPem = "-----BEGIN CERTIFICATE-----\nprivate-ca\n-----END CERTIFICATE-----";
    const ldaps = ldapConnectionPlan({ ...baseConfiguration, caPem }, baseConfiguration.urls[0]!);
    expect(ldaps.clientOptions).toMatchObject({
      strictDN: true,
      tlsOptions: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    });
    expect(ldaps.clientOptions.tlsOptions?.ca?.[0]?.toString("utf8")).toBe(caPem);
    expect(ldaps).not.toHaveProperty("startTlsOptions");

    const startTls = ldapConnectionPlan(
      { ...baseConfiguration, caPem, tlsMode: "starttls" },
      "ldap://ldap.internal:389",
    );
    expect(startTls.clientOptions).not.toHaveProperty("tlsOptions");
    expect(startTls.startTlsOptions).toMatchObject({
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
    });
  });

  it("keeps TLS 1.2 while explicitly allowing certificate verification to be disabled", () => {
    const ldaps = ldapConnectionPlan(
      { ...baseConfiguration, verifyTlsCertificate: false },
      baseConfiguration.urls[0]!,
    );
    expect(ldaps.clientOptions.tlsOptions).toMatchObject({
      minVersion: "TLSv1.2",
      rejectUnauthorized: false,
    });

    const startTls = ldapConnectionPlan(
      { ...baseConfiguration, tlsMode: "starttls", verifyTlsCertificate: false },
      "ldap://ldap.internal:389",
    );
    expect(startTls.startTlsOptions).toMatchObject({
      minVersion: "TLSv1.2",
      rejectUnauthorized: false,
    });
  });

  it("uses paging, maps multiple and nested groups, and keeps user enumeration bounded", async () => {
    const search = vi.fn(async (baseDn: string, options: Record<string, unknown>) => {
      if (baseDn === baseConfiguration.userBaseDn) {
        expect(options).toMatchObject({
          sizeLimit: baseConfiguration.maximumUsers,
          paged: { pageSize: baseConfiguration.pageSize },
        });
        return {
          searchEntries: [
            {
              dn: "uid=one,ou=people,dc=example,dc=test",
              entryUUID: "subject-1",
              uid: "one",
              displayName: "User One",
              mail: "one@example.test",
            },
          ],
        };
      }
      expect(String(options.filter)).toContain("uid=one,ou=people,dc=example,dc=test");
      return {
        searchEntries: [
          { dn: "cn=direct,ou=groups,dc=example,dc=test" },
          { dn: "cn=nested,ou=groups,dc=example,dc=test" },
        ],
      };
    });
    const client = fakeClient(search);
    const directory = new LdapDirectory(async () => client);

    await expect(directory.listUsers(baseConfiguration)).resolves.toEqual([
      expect.objectContaining({
        subject: "subject-1",
        username: "one",
        groupDns: [
          "cn=direct,ou=groups,dc=example,dc=test",
          "cn=nested,ou=groups,dc=example,dc=test",
        ],
      }),
    ]);
    expect(client.bind).toHaveBeenCalledWith(
      baseConfiguration.bindDn,
      baseConfiguration.bindPassword,
    );
    expect(client.unbind).toHaveBeenCalledOnce();
  });

  it("escapes special filter characters and rejects duplicate directory identities", async () => {
    const search = vi.fn(async (_baseDn: string, options: Record<string, unknown>) => {
      expect(options.filter).toBe(
        "(&(objectClass=person)(uid=alice\\2a\\29\\28uid=\\2a\\29\\28\\00))",
      );
      return { searchEntries: [{ dn: "uid=one" }, { dn: "uid=two" }] };
    });
    const directory = new LdapDirectory(async () => fakeClient(search));

    await expect(
      directory.authenticate(baseConfiguration, "alice*)(uid=*)(\u0000", "password"),
    ).rejects.toMatchObject({ code: "LDAP_CREDENTIAL_REJECTED" });
  });

  it("fails over after a timeout and reports directory loss when every server fails", async () => {
    const working = fakeClient(
      vi.fn().mockResolvedValue({ searchEntries: [{ entryUUID: "service" }] }),
    );
    let attempts = 0;
    const connector: LdapConnector = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ETIMEDOUT");
      return working;
    };
    await expect(new LdapDirectory(connector).test(baseConfiguration)).resolves.toBeUndefined();
    expect(attempts).toBe(2);

    const unavailable = new LdapDirectory(async () => {
      throw new Error("ETIMEDOUT");
    });
    await expect(unavailable.test(baseConfiguration)).rejects.toMatchObject({
      code: "LDAP_CONNECTION_TIMEOUT",
    });
  });
});

function fakeClient(search: ReturnType<typeof vi.fn>) {
  return {
    bind: vi.fn().mockResolvedValue(undefined),
    search,
    startTLS: vi.fn().mockResolvedValue(undefined),
    unbind: vi.fn().mockResolvedValue(undefined),
  } as unknown as Awaited<ReturnType<LdapConnector>>;
}
