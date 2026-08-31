import type { DirectoryConfiguration } from "@autoforge/application";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { LdapDirectory, ldapConnectionPlan, type LdapConnector } from "./ldap-directory";

const baseConfiguration: DirectoryConfiguration = {
  enabled: true,
  url: "ldaps://ldap.internal:636",
  tlsRejectUnauthorized: true,
  connectTimeoutMs: 5_000,
  bindDn: "cn=service,dc=example,dc=test",
  bindPassword: "bind-secret",
  userBaseDn: "ou=people,dc=example,dc=test",
  userFilter: "(&(objectClass=person)(uid={{username}}))",
  displayNameAttribute: "displayName",
  mailAttribute: "mail",
  groupAttribute: "memberOf",
  groupSearchBase: "ou=groups,dc=example,dc=test",
  groupSearchFilter: "(&(objectClass=groupOfNames)(member={{userDn}}))",
  groupNameAttribute: "cn",
  defaultRole: "editor",
};

describe("DDT Insight LDAP directory compatibility", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("derives plain LDAP and implicit TLS directly from the configured URL", () => {
    const ldaps = ldapConnectionPlan(baseConfiguration, baseConfiguration.url);
    expect(ldaps.clientOptions).toMatchObject({
      connectTimeout: 5_000,
      timeout: 5_000,
      strictDN: true,
      tlsOptions: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    });

    const plain = ldapConnectionPlan(
      { ...baseConfiguration, url: "ldap://ldap.internal:389" },
      "ldap://ldap.internal:389",
    );
    expect(plain.clientOptions).not.toHaveProperty("tlsOptions");

    const implicitTls = ldapConnectionPlan(
      { ...baseConfiguration, url: "ldap://ldap.internal:636" },
      "ldap://ldap.internal:636",
    );
    expect(implicitTls.clientOptions.tlsOptions).toMatchObject({ minVersion: "TLSv1.2" });
  });

  it("keeps TLS encryption while explicitly allowing certificate verification to be disabled", () => {
    const ldaps = ldapConnectionPlan(
      { ...baseConfiguration, tlsRejectUnauthorized: false },
      baseConfiguration.url,
    );
    expect(ldaps.clientOptions.tlsOptions).toMatchObject({
      minVersion: "TLSv1.2",
      rejectUnauthorized: false,
    });
  });

  it("supports anonymous user search and stores direct Group values as profile data", async () => {
    const search = vi.fn(async () => ({
      searchEntries: [
        {
          dn: "uid=one,ou=people,dc=example,dc=test",
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

  it("uses the submitted login name and never requests a directory username attribute", async () => {
    const search = vi.fn(async () => ({
      searchEntries: [
        {
          dn: "cn=directory-user,ou=people,dc=example,dc=test",
          uid: "different-canonical-name",
          displayName: "Directory User",
          mail: "directory-user@example.test",
        },
      ],
    }));
    const client = fakeClient(search);
    const directory = new LdapDirectory(async () => client);

    await expect(
      directory.authenticate(
        { ...baseConfiguration, groupSearchBase: "" },
        "Directory-User",
        "Directory!123",
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        subject: "directory-user",
        username: "Directory-User",
        displayName: "Directory User",
      }),
    );
    expect(search).toHaveBeenCalledWith(
      baseConfiguration.userBaseDn,
      expect.objectContaining({ attributes: ["displayName", "mail", "memberOf"] }),
    );
  });

  it("queries configured Groups and returns only their configured display attribute", async () => {
    const search = vi.fn(async (baseDn: string, options: Record<string, unknown>) => {
      if (baseDn === baseConfiguration.userBaseDn) {
        return {
          searchEntries: [
            {
              dn: "uid=one,ou=people,dc=example,dc=test",
              displayName: "User One",
            },
          ],
        };
      }
      expect(options).toMatchObject({
        filter: "(&(objectClass=groupOfNames)(member=uid=one,ou=people,dc=example,dc=test))",
        sizeLimit: 512,
        attributes: ["cn"],
      });
      return { searchEntries: [{ CN: "Viewers" }, { cn: "Release Operators" }] };
    });
    const directory = new LdapDirectory(async () => fakeClient(search));

    await expect(
      directory.authenticate(baseConfiguration, "one", "Directory!123"),
    ).resolves.toEqual(expect.objectContaining({ groupDns: ["Viewers", "Release Operators"] }));
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
