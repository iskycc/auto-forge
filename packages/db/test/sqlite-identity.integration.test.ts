import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { IdentityAccessService, type DirectoryIdentity } from "@autoforge/application";
import { DEFAULT_PROJECT_ID, DomainError } from "@autoforge/domain";
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
  it("bootstraps once, locks and unlocks local users, revokes sessions and maps LDAP groups", async () => {
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
    const directoryIdentity: DirectoryIdentity = {
      subject: "directory-subject-1",
      username: "ldap.user",
      displayName: "LDAP User",
      email: "ldap.user@example.test",
      distinguishedName: "uid=ldap.user,ou=people,dc=example,dc=test",
      groupDns: ["cn=autoforge-viewers,ou=groups,dc=example,dc=test"],
      attributes: { uid: "ldap.user", entryUUID: "directory-subject-1" },
    };
    let directoryUsers = [directoryIdentity];
    let directoryAvailable = true;
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
          if (!directoryAvailable) {
            throw new DomainError("LDAP_CONNECTION_TIMEOUT", "LDAP directory timed out.");
          }
          if (username !== "ldap.user" || password !== "Directory!123") {
            throw new Error("invalid directory credential");
          }
          return directoryIdentity;
        },
        listUsers: async () => directoryUsers,
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
      expect(viewer).toBeDefined();
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
        urls: ["ldaps://ldap.example.test:636"],
        tlsMode: "ldaps",
        connectTimeoutMs: 5_000,
        operationTimeoutMs: 10_000,
        pageSize: 500,
        maximumUsers: 5_000,
        synchronizationIntervalMinutes: 0,
        bindDn: "cn=service,dc=example,dc=test",
        bindPassword: "Bind!Password123",
        userBaseDn: "ou=people,dc=example,dc=test",
        userFilter: "(&(objectClass=person)(uid={username}))",
        userIdAttribute: "entryUUID",
        usernameAttribute: "uid",
        displayNameAttribute: "displayName",
        emailAttribute: "mail",
        groupBaseDn: "ou=groups,dc=example,dc=test",
        groupFilter: "(&(objectClass=groupOfNames)(member={userDn}))",
        groupMemberAttribute: "member",
      });
      await service.addLdapGroupMapping(administrator, {
        groupDn: "cn=autoforge-viewers,ou=groups,dc=example,dc=test",
        roleId: viewer!.id,
        projectId: DEFAULT_PROJECT_ID,
        priority: 100,
      });
      const ldapSession = await service.login({
        username: "ldap.user",
        password: "Directory!123",
        provider: "ldap",
      });
      const ldapIdentity = await service.authenticateSession(ldapSession.token);
      expect(ldapIdentity.user).toMatchObject({ source: "ldap", username: "ldap.user" });
      expect(ldapIdentity.projectPermissions[DEFAULT_PROJECT_ID]).toContain("case.read");
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
          provider: "ldap",
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

      const activeLdapSession = await service.login({
        username: "ldap.user",
        password: "Directory!123",
        provider: "ldap",
      });
      directoryUsers = [];
      const sync = await service.synchronizeLdap(administrator);
      expect(sync.disabledUserIds).toContain(ldapIdentity.user.id);
      await expect(service.authenticateSession(activeLdapSession.token)).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
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
          expect.objectContaining({ action: "ldap.synchronize" }),
          expect.objectContaining({
            action: "terminal.session_finished",
            details: expect.objectContaining({ inputMessages: 2, outputBytes: 32 }),
          }),
        ]),
      );
      const expiringSession = await service.login({
        username: "permission-user",
        password: "Permission!12345",
        provider: "local",
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
        listUsers: async () => [],
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
    } finally {
      handle.close();
    }
  });
});

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
