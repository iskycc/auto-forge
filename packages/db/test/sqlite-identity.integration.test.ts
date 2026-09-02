import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  IdentityAccessService,
  type CompleteLdapLoginRecord,
  type DirectoryIdentity,
} from "@autoforge/application";
import { builtInRoleDefinitions, DEFAULT_PROJECT_ID, DomainError } from "@autoforge/domain";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteDatabase } from "../src/database";
import { SqliteIdentityAccessRepository } from "../src/sqlite-identity-access";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SQLite identity access", () => {
  it("repairs a historical LDAP subject link by preferring the submitted username", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-ldap-link-"));
    temporaryDirectories.push(directory);
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "identity.db"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    const repository = new SqliteIdentityAccessRepository(handle);
    const synchronizedAt = "2026-09-02T00:00:00.000Z";
    try {
      const historical = await repository.upsertLdapUser({
        userId: "00000000-0000-7000-9100-000000000001",
        externalIdentityId: "00000000-0000-7000-9200-000000000001",
        providerId: "ldap:default",
        identity: ldapIdentity("retired.name", "current.name"),
        synchronizedAt,
      });
      const current = await repository.upsertLdapUser({
        userId: "00000000-0000-7000-9100-000000000002",
        externalIdentityId: "00000000-0000-7000-9200-000000000002",
        providerId: "ldap:default",
        identity: ldapIdentity("current.name", "current-directory-subject"),
        synchronizedAt,
      });

      const repaired = await repository.upsertLdapUser({
        userId: historical.id,
        externalIdentityId: "00000000-0000-7000-9200-000000000003",
        providerId: "ldap:default",
        identity: ldapIdentity("current.name", "current.name"),
        synchronizedAt: "2026-09-02T00:01:00.000Z",
      });

      expect(repaired.id).toBe(current.id);
      await expect(
        repository.findExternalIdentity("ldap:default", "current.name"),
      ).resolves.toMatchObject({ userId: current.id, directoryUsername: "current.name" });
      await expect(repository.findUser(historical.id)).resolves.toMatchObject({
        username: "retired.name",
      });
    } finally {
      handle.close();
    }
  });

  it("rolls back the complete first LDAP login and assigns the default role only once", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-ldap-login-"));
    temporaryDirectories.push(directory);
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "identity.db"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    const repository = new SqliteIdentityAccessRepository(handle);
    const synchronizedAt = "2026-09-02T00:00:00.000Z";
    const duplicateAuditId = "00000000-0000-7000-9600-000000000001";
    const login = ldapLoginRecord(duplicateAuditId, synchronizedAt);
    try {
      await repository.ensureBuiltInRoles(builtInRoleDefinitions, synchronizedAt);
      await repository.appendAudit({
        id: duplicateAuditId,
        actorType: "system",
        action: "test.seed",
        resourceType: "test",
        result: "succeeded",
        details: {},
        recordedAt: synchronizedAt,
      });

      await expect(repository.completeLdapLogin(login)).rejects.toThrow();
      await expect(repository.findUserByUsername("atomic.ldap")).resolves.toBeNull();
      await expect(
        repository.findExternalIdentity("ldap:default", "atomic-directory-subject"),
      ).resolves.toBeNull();
      expect(
        handle.client
          .prepare("SELECT COUNT(*) AS value FROM user_sessions WHERE id = ?")
          .get(login.session.id),
      ).toEqual({ value: 0 });

      handle.client.prepare("DELETE FROM audit_events WHERE id = ?").run(duplicateAuditId);
      await expect(repository.completeLdapLogin(login)).resolves.toMatchObject({
        username: "atomic.ldap",
        source: "ldap",
      });
      await expect(
        repository.resolveSession(login.session.tokenHash, "2026-09-02T00:01:00.000Z"),
      ).resolves.toMatchObject({
        user: { username: "atomic.ldap" },
        projectPermissions: { [DEFAULT_PROJECT_ID]: expect.arrayContaining(["case.manage"]) },
      });

      const repeatedLogin = ldapLoginRecord(
        "00000000-0000-7000-9600-000000000002",
        "2026-09-02T00:02:00.000Z",
      );
      repeatedLogin.session.id = "00000000-0000-7000-9500-000000000002";
      repeatedLogin.session.tokenHash = "atomic-token-hash-2";
      await repository.completeLdapLogin(repeatedLogin);
      expect(
        handle.client
          .prepare(
            `SELECT COUNT(*) AS value FROM project_role_bindings
             WHERE user_id = ? AND project_id = ? AND role_id = ? AND source = 'ldap'`,
          )
          .get(login.ldapUser.userId, DEFAULT_PROJECT_ID, "00000000-0000-7000-8100-000000000003"),
      ).toEqual({ value: 1 });
    } finally {
      handle.close();
    }
  });

  it("retries the complete first LDAP login after transient SQLite write contention", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-ldap-busy-"));
    temporaryDirectories.push(directory);
    const databasePath = resolve(directory, "identity.db");
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/sqlite");
    const lockingHandle = createSqliteDatabase({ databasePath, migrationsFolder });
    const loginHandle = createSqliteDatabase({ databasePath, migrationsFolder });
    const repository = new SqliteIdentityAccessRepository(loginHandle);
    const synchronizedAt = "2026-09-02T00:00:00.000Z";
    let lockHeld = false;
    let releaseLock: ReturnType<typeof setTimeout> | undefined;
    try {
      await repository.ensureBuiltInRoles(builtInRoleDefinitions, synchronizedAt);
      loginHandle.client.pragma("busy_timeout = 1");
      lockingHandle.client.exec("BEGIN IMMEDIATE");
      lockHeld = true;
      releaseLock = setTimeout(() => {
        lockingHandle.client.exec("COMMIT");
        lockHeld = false;
      }, 10);

      const login = ldapLoginRecord("00000000-0000-7000-9600-000000000003", synchronizedAt);
      await expect(repository.completeLdapLogin(login)).resolves.toMatchObject({
        username: "atomic.ldap",
      });
      await expect(
        repository.resolveSession(login.session.tokenHash, "2026-09-02T00:01:00.000Z"),
      ).resolves.toMatchObject({ user: { username: "atomic.ldap" } });
    } finally {
      if (releaseLock) clearTimeout(releaseLock);
      if (lockHeld) lockingHandle.client.exec("ROLLBACK");
      loginHandle.close();
      lockingHandle.close();
    }
  });

  it("bootstraps once, manages local users, and stores LDAP Groups without mapping permissions", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-identity-"));
    temporaryDirectories.push(directory);
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "identity.db"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    const repository = new SqliteIdentityAccessRepository(handle);
    const clock = new MutableClock("2026-08-09T00:00:00.000Z");
    const ids = new SequentialIds();
    const tokens = new TestTokens();
    let directoryIdentity: DirectoryIdentity = {
      subject: "directory-subject-1",
      username: "ldap.user",
      displayName: "LDAP User",
      email: "ldap.user@example.test",
      distinguishedName: "uid=ldap.user,ou=people,dc=example,dc=test",
      groupDns: ["cn=autoforge-viewers,ou=groups,dc=example,dc=test"],
      attributes: { uid: "ldap.user", entryUUID: "directory-subject-1" },
    };
    let directoryAvailable = true;
    let directoryAuthenticationAttempts = 0;
    const service = new IdentityAccessService(
      repository,
      {
        hash: async (password) => `password:${password}`,
        verify: async (password, encoded) => encoded === `password:${password}`,
      },
      tokens,
      {
        available: true,
        encrypt: (plaintext, purpose) =>
          `${purpose}:${Buffer.from(plaintext).toString("base64url")}`,
        decrypt: (ciphertext, purpose) => {
          const prefix = `${purpose}:`;
          if (!ciphertext.startsWith(prefix)) throw new Error("cipher purpose mismatch");
          return Buffer.from(ciphertext.slice(prefix.length), "base64url").toString();
        },
      },
      {
        test: async () => undefined,
        authenticate: async (_configuration, username, password) => {
          directoryAuthenticationAttempts += 1;
          if (!directoryAvailable) {
            throw new DomainError("LDAP_CONNECTION_TIMEOUT", "LDAP directory timed out.");
          }
          if (username !== "ldap.user" || password !== "Directory!123") {
            throw new Error("invalid directory credential");
          }
          return directoryIdentity;
        },
      },
      clock,
      ids,
      8,
    );

    try {
      await service.initialize();
      expect(await service.setupRequired()).toBe(true);
      const bootstrap = await service.bootstrap({
        bootstrapToken: TestTokens.bootstrapToken,
        username: "administrator",
        displayName: "Administrator",
        password: "Admin!Password123",
      });
      const administrator = await service.authenticateSession(bootstrap.token);
      expect(administrator.systemPermissions).toContain("user.manage");
      expect(await service.setupRequired()).toBe(false);
      await expect(
        service.bootstrap({
          bootstrapToken: TestTokens.bootstrapToken,
          username: "second-admin",
          displayName: "Second",
          password: "Admin!Password456",
        }),
      ).rejects.toMatchObject({ code: "AUTH_BOOTSTRAP_REJECTED" });

      const localUser = await service.createUser(administrator, {
        username: "operator",
        displayName: "Operator",
        password: "Operator!12345",
        forcePasswordChange: true,
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(
          service.login({ username: "operator", password: "incorrect", provider: "local" }),
        ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
      }
      await expect(
        service.login({ username: "operator", password: "Operator!12345", provider: "local" }),
      ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
      await service.updateUserStatus(administrator, localUser.id, "active");
      const localSession = await service.login({
        username: "operator",
        password: "Operator!12345",
        provider: "local",
      });
      expect(await service.authenticateSession(localSession.token)).toMatchObject({
        user: { id: localUser.id },
      });
      await service.resetPassword(administrator, localUser.id, "Replacement!12345", true);
      await expect(service.authenticateSession(localSession.token)).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
      });
      const replacementSession = await service.login({
        username: "operator",
        password: "Replacement!12345",
        provider: "local",
      });
      await service.revokeUserSessions(administrator, localUser.id);
      await expect(service.authenticateSession(replacementSession.token)).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
      });

      const roles = await service.listRoles(administrator);
      const viewer = roles.find((role) => role.key === "viewer");
      const testManager = roles.find((role) => role.key === "test-manager");
      expect(viewer).toBeDefined();
      expect(testManager).toBeDefined();
      const permissionUser = await service.createUser(administrator, {
        username: "permission-user",
        displayName: "Permission User",
        password: "Permission!12345",
        forcePasswordChange: false,
      });
      await service.assignProjectRole(
        administrator,
        permissionUser.id,
        DEFAULT_PROJECT_ID,
        viewer!.id,
      );
      const permissionSession = await service.login({
        username: "permission-user",
        password: "Permission!12345",
        provider: "local",
      });
      expect(
        (await service.authenticateSession(permissionSession.token)).projectPermissions[
          DEFAULT_PROJECT_ID
        ],
      ).toContain("run.read");
      await service.removeProjectRole(
        administrator,
        permissionUser.id,
        DEFAULT_PROJECT_ID,
        viewer!.id,
      );
      await expect(service.authenticateSession(permissionSession.token)).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
      });
      await service.saveLdapConfiguration(administrator, {
        enabled: true,
        url: "ldaps://ldap.example.test:636",
        tlsRejectUnauthorized: false,
        connectTimeoutMs: 5_000,
        bindDn: "cn=service,dc=example,dc=test",
        bindPassword: "Bind!Password123",
        clearBindPassword: false,
        userBaseDn: "ou=people,dc=example,dc=test",
        userFilter: "(&(objectClass=person)(uid={{username}}))",
        displayNameAttribute: "displayName",
        mailAttribute: "mail",
        groupAttribute: "memberOf",
        groupSearchBase: "ou=groups,dc=example,dc=test",
        groupSearchFilter: "(&(objectClass=groupOfNames)(member={{userDn}}))",
        groupNameAttribute: "cn",
        defaultRole: "editor",
      });
      await expect(service.getLdapConfiguration(administrator)).resolves.toMatchObject({
        enabled: true,
        tlsRejectUnauthorized: false,
        updatedBy: "administrator",
      });
      const directoryAttemptsBeforeLocalLogin = directoryAuthenticationAttempts;
      const localSessionWithLegacyLdapHint = await service.login({
        username: "permission-user",
        password: "Permission!12345",
        provider: "ldap",
      });
      await expect(
        service.authenticateSession(localSessionWithLegacyLdapHint.token),
      ).resolves.toMatchObject({ user: { id: permissionUser.id, source: "local" } });
      expect(directoryAuthenticationAttempts).toBe(directoryAttemptsBeforeLocalLogin);
      const ldapSession = await service.login({
        username: "ldap.user",
        password: "Directory!123",
      });
      expect(directoryAuthenticationAttempts).toBe(directoryAttemptsBeforeLocalLogin + 1);
      const ldapIdentity = await service.authenticateSession(ldapSession.token);
      expect(ldapIdentity.user).toMatchObject({
        source: "ldap",
        username: "ldap.user",
        groups: ["cn=autoforge-viewers,ou=groups,dc=example,dc=test"],
      });
      expect(ldapIdentity.projectPermissions[DEFAULT_PROJECT_ID]).toContain("case.read");
      expect(ldapIdentity.projectPermissions[DEFAULT_PROJECT_ID]).toContain("case.manage");
      handle.client
        .prepare(
          "DELETE FROM project_role_bindings WHERE user_id = ? AND project_id = ? AND role_id = ?",
        )
        .run(ldapIdentity.user.id, DEFAULT_PROJECT_ID, testManager!.id);
      directoryIdentity = {
        ...directoryIdentity,
        subject: "ldap.user",
        displayName: "LDAP User Migrated",
        groupDns: ["auditors", "release-operators"],
      };
      const migratedLdapSession = await service.login({
        username: "ldap.user",
        password: "Directory!123",
      });
      const migratedLdapIdentity = await service.authenticateSession(migratedLdapSession.token);
      expect(migratedLdapIdentity).toMatchObject({
        user: {
          id: ldapIdentity.user.id,
          displayName: "LDAP User Migrated",
          groups: ["auditors", "release-operators"],
        },
      });
      expect(migratedLdapIdentity.projectPermissions[DEFAULT_PROJECT_ID]).toBeUndefined();
      await service.logout(migratedLdapIdentity);
      await expect(
        service.recordTerminalSession(
          ldapIdentity,
          "runner-forbidden",
          "terminal-forbidden",
          DEFAULT_PROJECT_ID,
        ),
      ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
      await expect(
        service.recordTerminalSession(
          administrator,
          "runner-authorized",
          "terminal-authorized",
          DEFAULT_PROJECT_ID,
        ),
      ).resolves.toBeUndefined();
      directoryAvailable = false;
      await expect(service.authenticateSession(ldapSession.token)).resolves.toMatchObject({
        user: { id: ldapIdentity.user.id },
      });
      await expect(
        service.login({
          username: "ldap.user",
          password: "Directory!123",
        }),
      ).rejects.toMatchObject({ code: "LDAP_CONNECTION_TIMEOUT" });
      await expect(service.authenticateSession(bootstrap.token)).resolves.toMatchObject({
        user: { id: administrator.user.id },
      });
      directoryAvailable = true;
      const sessions = await service.listSessions(administrator, ldapIdentity.user.id);
      expect(sessions).toHaveLength(1);
      await service.revokeManagedSession(administrator, sessions[0]!.id);
      await expect(service.authenticateSession(ldapSession.token)).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
      });
      await expect(
        service.removeSystemRole(
          administrator,
          administrator.user.id,
          "00000000-0000-7000-8100-000000000001",
        ),
      ).rejects.toMatchObject({ code: "LAST_ADMIN_REQUIRED" });

      const project = await service.createProject(administrator, {
        name: "Archived project",
        slug: "archived-project",
      });
      await expect(service.archiveProject(administrator, project.id)).resolves.toMatchObject({
        archived: true,
      });

      await service.recordTerminalLifecycle({
        actorId: administrator.user.id,
        runnerId: "runner-audit",
        sessionId: "terminal-session-audit",
        action: "terminal.session_finished",
        reason: "Browser disconnected",
        inputMessages: 2,
        inputBytes: 16,
        outputBytes: 32,
      });

      const audit = await service.listAudit(administrator, { limit: 100 });
      expect(audit.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: "auth.bootstrap", result: "succeeded" }),
          expect.objectContaining({ action: "user.password_reset" }),
          expect.objectContaining({ action: "user.sessions_revoke" }),
          expect.objectContaining({ action: "ldap.configure" }),
          expect.objectContaining({
            action: "terminal.session_finished",
            details: expect.objectContaining({ inputMessages: 2, outputBytes: 32 }),
          }),
        ]),
      );
      const projectAudit = await service.listAudit(administrator, {
        projectId: project.id,
        limit: 100,
      });
      expect(projectAudit.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: "project.archive", projectId: project.id }),
          expect.objectContaining({ action: "terminal.session_finished" }),
        ]),
      );
      const expiringSession = await service.login({
        username: "permission-user",
        password: "Permission!12345",
      });
      clock.advanceHours(9);
      await expect(service.authenticateSession(expiringSession.token)).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
      });
    } finally {
      handle.close();
    }
  });

  it("enforces role deactivation, administrator guards and project ownership", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-roles-"));
    temporaryDirectories.push(directory);
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "identity.db"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    const repository = new SqliteIdentityAccessRepository(handle);
    const clock = new MutableClock("2026-08-09T00:00:00.000Z");
    const service = new IdentityAccessService(
      repository,
      {
        hash: async (password) => `password:${password}`,
        verify: async (password, encoded) => encoded === `password:${password}`,
      },
      new TestTokens(),
      {
        available: true,
        encrypt: (plaintext, purpose) =>
          `${purpose}:${Buffer.from(plaintext).toString("base64url")}`,
        decrypt: (ciphertext, purpose) => {
          const prefix = `${purpose}:`;
          if (!ciphertext.startsWith(prefix)) throw new Error("cipher purpose mismatch");
          return Buffer.from(ciphertext.slice(prefix.length), "base64url").toString();
        },
      },
      {
        test: async () => undefined,
        authenticate: async () => {
          throw new Error("directory unavailable");
        },
      },
      clock,
      new SequentialIds(),
      8,
    );

    try {
      await service.initialize();
      const bootstrap = await service.bootstrap({
        bootstrapToken: TestTokens.bootstrapToken,
        username: "administrator",
        displayName: "Administrator",
        password: "Admin!Password123",
      });
      const administrator = await service.authenticateSession(bootstrap.token);

      const recoveryRole = await service.createRole(administrator, {
        key: "recovery-admin",
        name: "Recovery Admin",
        description: "Custom recovery administrator",
        scope: "system",
        permissions: ["user.manage", "role.manage"],
      });
      expect(recoveryRole.active).toBe(true);
      const secondAdmin = await service.createUser(administrator, {
        username: "second-admin",
        displayName: "Second Admin",
        password: "Second!Password1",
        forcePasswordChange: false,
      });
      await service.assignSystemRole(administrator, secondAdmin.id, recoveryRole.id);
      const secondSession = await service.login({
        username: "second-admin",
        password: "Second!Password1",
        provider: "local",
      });
      expect((await service.authenticateSession(secondSession.token)).systemPermissions).toContain(
        "user.manage",
      );

      await service.updateRole(administrator, recoveryRole.id, { active: false });
      await expect(service.authenticateSession(secondSession.token)).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
      });
      const relogin = await service.login({
        username: "second-admin",
        password: "Second!Password1",
        provider: "local",
      });
      expect((await service.authenticateSession(relogin.token)).systemPermissions).not.toContain(
        "user.manage",
      );
      await expect(
        service.assignSystemRole(administrator, secondAdmin.id, recoveryRole.id),
      ).rejects.toMatchObject({ code: "ROLE_INACTIVE" });

      // 自定义角色已停用，bootstrap 管理员是唯一剩余管理员，移除其绑定必须被拒绝。
      await expect(
        service.removeSystemRole(
          administrator,
          administrator.user.id,
          "00000000-0000-7000-8100-000000000001",
        ),
      ).rejects.toMatchObject({ code: "LAST_ADMIN_REQUIRED" });

      await service.updateRole(administrator, recoveryRole.id, { active: true });
      // 重新启用后绑定可再次生效，且守卫不误伤非最后管理员的移除。
      await service.assignSystemRole(administrator, secondAdmin.id, recoveryRole.id);
      await expect(
        service.removeSystemRole(administrator, secondAdmin.id, recoveryRole.id),
      ).resolves.toBeUndefined();
      const secondAdminRelogin = await service.login({
        username: "second-admin",
        password: "Second!Password1",
        provider: "local",
      });
      expect(
        (await service.authenticateSession(secondAdminRelogin.token)).systemPermissions,
      ).not.toContain("user.manage");

      // bootstrap 管理员仍持有内置系统角色，项目操作不受影响。
      const project = await service.createProject(administrator, {
        name: "Owned project",
        slug: "owned-project",
      });
      expect(project.ownerUserId).toBe(administrator.user.id);
      await service.updateUserStatus(administrator, secondAdmin.id, "disabled");
      await expect(
        service.transferProjectOwner(administrator, project.id, {
          ownerUserId: secondAdmin.id,
        }),
      ).rejects.toMatchObject({ code: "PROJECT_OWNER_INACTIVE" });
      await service.updateUserStatus(administrator, secondAdmin.id, "active");
      const transferred = await service.transferProjectOwner(administrator, project.id, {
        ownerUserId: secondAdmin.id,
      });
      expect(transferred.ownerUserId).toBe(secondAdmin.id);
      expect(
        (await service.listProjects(administrator)).find((candidate) => candidate.id === project.id)
          ?.ownerUserId,
      ).toBe(secondAdmin.id);
      const transferredMembers = await service.listProjectMembers(administrator, project.id);
      expect(
        transferredMembers.find((member) => member.user.id === secondAdmin.id)?.roleIds,
      ).toContain("00000000-0000-7000-8100-000000000002");
      await expect(
        service.removeProjectRole(
          administrator,
          secondAdmin.id,
          project.id,
          "00000000-0000-7000-8100-000000000002",
        ),
      ).rejects.toMatchObject({ code: "PROJECT_OWNER_ROLE_REQUIRED" });
    } finally {
      handle.close();
    }
  });
});

function ldapLoginRecord(auditId: string, synchronizedAt: string): CompleteLdapLoginRecord {
  return {
    ldapUser: {
      userId: "00000000-0000-7000-9300-000000000001",
      externalIdentityId: "00000000-0000-7000-9400-000000000001",
      providerId: "ldap:default",
      identity: ldapIdentity("atomic.ldap", "atomic-directory-subject"),
      synchronizedAt,
    },
    defaultRole: {
      roleId: "00000000-0000-7000-8100-000000000003",
      projectId: DEFAULT_PROJECT_ID,
      recordedAt: synchronizedAt,
    },
    session: {
      id: "00000000-0000-7000-9500-000000000001",
      tokenHash: "atomic-token-hash-1",
      createdAt: synchronizedAt,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    audit: {
      id: auditId,
      actorType: "user",
      action: "auth.login",
      resourceType: "session",
      result: "succeeded",
      details: { provider: "ldap" },
      recordedAt: synchronizedAt,
    },
  };
}

function ldapIdentity(username: string, subject: string): DirectoryIdentity {
  return {
    subject,
    username,
    displayName: username,
    distinguishedName: `uid=${username},ou=people,dc=example,dc=test`,
    groupDns: [],
    attributes: { uid: username },
  };
}

class MutableClock {
  constructor(private instant: string) {}

  now(): Date {
    return new Date(this.instant);
  }

  advanceHours(hours: number): void {
    this.instant = new Date(new Date(this.instant).getTime() + hours * 3_600_000).toISOString();
  }
}

class SequentialIds {
  private sequence = 0;

  next(): string {
    this.sequence += 1;
    return `00000000-0000-7000-9000-${String(this.sequence).padStart(12, "0")}`;
  }
}

class TestTokens {
  static readonly bootstrapToken = "bootstrap-token-with-at-least-thirty-two-characters";
  private sequence = 0;

  issue(): string {
    this.sequence += 1;
    return `session-token-${this.sequence}`;
  }

  hash(value: string): string {
    return `digest:${value}`;
  }

  verifyBootstrapToken(value: string): boolean {
    return value === TestTokens.bootstrapToken;
  }
}
