import type { DirectoryConfiguration } from "@autoforge/application";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { LdapDirectory, ldapConnectionPlan, type LdapConnector } from "./ldap-directory";

const baseConfiguration: DirectoryConfiguration = {
  enabled: true,
  url: "ldaps://ldap.internal:636",
  transportMode: "ldaps",
  verifyTlsCertificate: true,
  connectTimeoutMs: 2_000,
  operationTimeoutMs: 5_000,
  pageSize: 250,
  maximumUsers: 5_000,
  synchronizationIntervalMinutes: 30,
  bindDn: "cn=service,dc=example,dc=test",
  bindPassword: "bind-secret",
  userBaseDn: "ou=people,dc=example,dc=test",
  userFilter: "(&(objectClass=person)(uid={{username}}))",
  usernameAttribute: "uid",
  displayNameAttribute: "displayName",
  emailAttribute: "mail",
  groupAttribute: "memberOf",
  groupSearchBase: "ou=groups,dc=example,dc=test",
  groupSearchFilter: "(&(objectClass=groupOfNames)(member={{userDn}}))",
  groupNameAttribute: "cn",
  defaultRole: "editor",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  version: 1,
};

describe("LDAP directory compatibility", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("derives plain LDAP and implicit TLS directly from the configured URL", () => {
    const caPem = "-----BEGIN CERTIFICATE-----\nprivate-ca\n-----END CERTIFICATE-----";
    const ldaps = ldapConnectionPlan({ ...baseConfiguration, caPem }, baseConfiguration.url);
    expect(ldaps.clientOptions).toMatchObject({
      strictDN: true,
      tlsOptions: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    });
    expect(ldaps.clientOptions.tlsOptions?.ca?.[0]?.toString("utf8")).toBe(caPem);

    const plain = ldapConnectionPlan(
      { ...baseConfiguration, url: "ldap://ldap.internal:389", transportMode: "plain" },
      "ldap://ldap.internal:389",
    );
    expect(plain.clientOptions).not.toHaveProperty("tlsOptions");
    expect(plain).not.toHaveProperty("startTlsOptions");

    const legacyStartTls = ldapConnectionPlan(
      { ...baseConfiguration, url: "ldap://ldap.internal:636", transportMode: "starttls" },
      "ldap://ldap.internal:636",
    );
    expect(legacyStartTls.clientOptions).not.toHaveProperty("tlsOptions");
    expect(legacyStartTls.startTlsOptions).toMatchObject({
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
    });

    const legacyImplicitTls = ldapConnectionPlan(
      { ...baseConfiguration, url: "ldap://ldap.internal:636" },
      "ldap://ldap.internal:636",
    );
    expect(legacyImplicitTls.clientOptions.tlsOptions).toMatchObject({ minVersion: "TLSv1.2" });
  });

  it("keeps TLS encryption while explicitly allowing certificate verification to be disabled", () => {
    const ldaps = ldapConnectionPlan(
      { ...baseConfiguration, verifyTlsCertificate: false },
      baseConfiguration.url,
    );
    expect(ldaps.clientOptions.tlsOptions).toMatchObject({
      minVersion: "TLSv1.2",
      rejectUnauthorized: false,
    });
  });

  it("allows anonymous search, maps case-insensitive attributes and reads direct memberOf values", async () => {
    const search = vi.fn(async () => ({
      searchEntries: [
        {
          dn: "uid=one,ou=people,dc=example,dc=test",
          UID: "One",
          DISPLAYNAME: "User One",
          MAIL: "one@example.test",
          "memberOf;range=0-*": [
            "cn=Viewers,ou=groups,dc=example,dc=test",
            "cn=viewers,ou=groups,dc=example,dc=test",
          ],
        },
      ],
    }));
    const client = fakeClient(search);
    const directory = new LdapDirectory(async () => client);
    const configuration = {
      ...baseConfiguration,
      bindDn: "",
      bindPassword: "",
      groupSearchBase: "",
    };

    await expect(directory.authenticate(configuration, "One", "Directory!123")).resolves.toEqual(
      expect.objectContaining({
        subject: "one",
        username: "One",
        displayName: "User One",
        groupDns: ["cn=Viewers,ou=groups,dc=example,dc=test"],
      }),
    );
    expect(client.bind).not.toHaveBeenCalledWith("", "");
    expect(client.bind).toHaveBeenCalledWith(
      "uid=one,ou=people,dc=example,dc=test",
      "Directory!123",
    );
  });

  it("uses paging and maps Group search results to their configured human-readable name", async () => {
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
              uid: "one",
              displayName: "User One",
              mail: "one@example.test",
            },
          ],
        };
      }
      expect(String(options.filter)).toContain("uid=one,ou=people,dc=example,dc=test");
      return { searchEntries: [{ CN: "AutoForge Viewers" }, { cn: "Release Operators" }] };
    });
    const client = fakeClient(search);
    const directory = new LdapDirectory(async () => client);
    const configuration = {
      ...baseConfiguration,
      emailAttribute: "",
      groupAttribute: "",
    };

    await expect(directory.listUsers(configuration)).resolves.toEqual([
      expect.objectContaining({
        subject: "one",
        username: "one",
        groupDns: ["AutoForge Viewers", "Release Operators"],
      }),
    ]);
    expect(client.bind).toHaveBeenCalledWith(configuration.bindDn, configuration.bindPassword);
    expect(search.mock.calls[0]?.[1]).toMatchObject({
      attributes: ["uid", "displayName"],
    });
    expect(client.unbind).toHaveBeenCalledOnce();
  });

  it("keeps historical DN-based Group mappings usable after upgrade", async () => {
    const search = vi.fn(async (baseDn: string) =>
      baseDn === baseConfiguration.userBaseDn
        ? {
            searchEntries: [
              {
                dn: "uid=one,ou=people,dc=example,dc=test",
                uid: "one",
                displayName: "User One",
              },
            ],
          }
        : {
            searchEntries: [
              { dn: "cn=Viewers,ou=groups,dc=example,dc=test" },
              { dn: "cn=Auditors,ou=groups,dc=example,dc=test" },
            ],
          },
    );
    const directory = new LdapDirectory(async () => fakeClient(search));

    await expect(
      directory.listUsers({ ...baseConfiguration, groupNameAttribute: "dn" }),
    ).resolves.toEqual([
      expect.objectContaining({
        groupDns: [
          "cn=Viewers,ou=groups,dc=example,dc=test",
          "cn=Auditors,ou=groups,dc=example,dc=test",
        ],
      }),
    ]);
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

  it("reports directory loss when the configured server times out", async () => {
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
    unbind: vi.fn().mockResolvedValue(undefined),
  } as unknown as Awaited<ReturnType<LdapConnector>>;
}
