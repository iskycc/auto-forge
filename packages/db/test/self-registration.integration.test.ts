import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  IdentityAccessService,
  type CompleteLocalRegistrationRecord,
  type IdentityAccessRepository,
} from "@autoforge/application";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteIdentityAccessRepository } from "../src/sqlite-identity-access";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { PostgresIdentityAccessRepository } from "../src/postgres-identity-access";

const now = "2026-11-02T00:00:00.000Z";
const password = "Register!Password123";
const registration = {
  username: "New.User",
  displayName: "本地新用户",
  password,
  confirmPassword: password,
};
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

for (const mode of ["lite", "full"] as const) {
  describe.skipIf(mode === "full" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${mode} self registration`,
    () => {
      it("protects initialization and creates a persistent directly authenticated local account", async () => {
        const f = await fixture(mode);
        try {
          await expect(f.service.register(registration)).rejects.toMatchObject({
            code: "AUTH_REGISTRATION_UNAVAILABLE",
          });
          await expect(f.repository.completeLocalRegistration(record())).rejects.toMatchObject({
            code: "AUTH_REGISTRATION_UNAVAILABLE",
          });
          expect(await f.service.setupRequired()).toBe(true);
          await f.bootstrap();
          const session = await f.service.register(registration, "registration-request");
          const identity = await f.service.authenticateSession(session.token);
          expect(identity.user).toMatchObject({
            username: "New.User",
            source: "local",
            forcePasswordChange: false,
            lastLoginAt: now,
          });
          expect(identity.systemPermissions).toEqual([]);
          expect(Object.keys(identity.projectPermissions)).toEqual([DEFAULT_PROJECT_ID]);
          expect(identity.projectPermissions[DEFAULT_PROJECT_ID]).toEqual(
            expect.arrayContaining(["run.create", "run.cancel", "log.read"]),
          );
          expect(await f.repository.listUserProjectRoleBindings([identity.user.id])).toEqual([
            {
              userId: identity.user.id,
              projectId: DEFAULT_PROJECT_ID,
              roleId: "00000000-0000-7000-8100-000000000004",
            },
          ]);
          const stored = await f.repository.findUserByUsername("new.user");
          expect(stored?.passwordHash).toBe(digest(password));
          expect(stored?.passwordHash).not.toBe(password);
          const audit = await f.repository.listAudit({ action: "auth.register", limit: 10 });
          expect(audit.items).toHaveLength(1);
          expect(audit.items[0]).toMatchObject({
            actorId: session.userId,
            resourceId: session.userId,
            requestId: "registration-request",
            result: "succeeded",
          });
          expect(JSON.stringify(audit.items)).not.toContain(password);
          await f.service.logout(identity);
          await expect(f.service.authenticateSession(session.token)).rejects.toMatchObject({
            code: "AUTH_REQUIRED",
          });
          const relogin = await f.service.login({ username: "NEW.USER", password });
          expect(
            (await f.service.authenticateSession(relogin.token)).user.forcePasswordChange,
          ).toBe(false);
        } finally {
          await f.close();
        }
      });

      it("rolls back user and session together when registration audit persistence fails", async () => {
        const f = await fixture(mode);
        try {
          await f.bootstrap();
          const attempt = record();
          await f.repository.appendAudit({ ...attempt.audit, actorType: "system" });
          await expect(f.repository.completeLocalRegistration(attempt)).rejects.toThrow();
          expect(await f.repository.findUserByUsername(attempt.user.normalizedUsername)).toBeNull();
          expect(await f.repository.listUserProjectRoleBindings([attempt.user.id])).toEqual([]);
          expect(await f.repository.resolveSession(attempt.session.tokenHash, now)).toBeNull();
          const created = await f.repository.completeLocalRegistration({
            ...attempt,
            audit: { ...attempt.audit, id: randomUUID() },
          });
          expect(created.forcePasswordChange).toBe(false);
          expect(await f.repository.resolveSession(attempt.session.tokenHash, now)).not.toBeNull();
        } finally {
          await f.close();
        }
      });

      it("returns one account and one explicit conflict for concurrent normalized duplicates", async () => {
        const f = await fixture(mode);
        try {
          await f.bootstrap();
          const outcomes = await Promise.allSettled([
            f.service.register(registration),
            f.service.register({ ...registration, username: "new.USER" }),
          ]);
          expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
          expect(outcomes.find((result) => result.status === "rejected")).toMatchObject({
            reason: { code: "USER_CONFLICT" },
          });
          expect(
            (await f.repository.listUsers({ query: "New.User", limit: 10 })).items,
          ).toHaveLength(1);
          const user = (await f.repository.findUserByUsername("new.user"))!.user;
          expect(await f.repository.listUserSessions(user.id, now)).toHaveLength(1);
          expect(
            (await f.repository.listAudit({ action: "auth.register", limit: 10 })).items,
          ).toHaveLength(1);
        } finally {
          await f.close();
        }
      });

      it("blocks an in-flight registration when LDAP is enabled and reopens when it is disabled", async () => {
        const f = await fixture(mode);
        let finishHash = () => {};
        try {
          await f.bootstrap();
          let signalHashStarted = () => {};
          const hashStarted = new Promise<void>((resolve) => {
            signalHashStarted = resolve;
          });
          const hashReleased = new Promise<void>((resolve) => {
            finishHash = resolve;
          });
          const originalHash = f.passwords.hash;
          f.passwords.hash = async (text) => {
            signalHashStarted();
            await hashReleased;
            return originalHash(text);
          };
          const pending = f.service.register(registration);
          await hashStarted;
          const ldap = await f.repository.saveLdapConfiguration({
            enabled: true,
            url: "ldaps://127.0.0.1:10636",
            tlsRejectUnauthorized: true,
            connectTimeoutMs: 1000,
            bindDn: "",
            userBaseDn: "dc=example,dc=invalid",
            userFilter: "(uid={{username}})",
            displayNameAttribute: "displayName",
            mailAttribute: "mail",
            groupAttribute: "memberOf",
            groupSearchBase: "",
            groupSearchFilter: "(member={{userDn}})",
            groupNameAttribute: "cn",
            defaultRole: "viewer",
            updatedBy: "admin",
            updatedAt: now,
          });
          finishHash();
          await expect(pending).rejects.toMatchObject({ code: "AUTH_REGISTRATION_UNAVAILABLE" });
          expect(await f.repository.findUserByUsername("new.user")).toBeNull();
          expect(await f.service.registrationAvailability()).toEqual({
            enabled: false,
            reason: "ldap_enabled",
          });
          await expect(f.repository.completeLocalRegistration(record())).rejects.toMatchObject({
            code: "AUTH_REGISTRATION_UNAVAILABLE",
          });
          // Local users remain independent of the directory while registration is closed.
          expect((await f.service.login({ username: "admin", password })).userId).toBeTruthy();
          await f.repository.saveLdapConfiguration({ ...ldap, enabled: false, updatedAt: now });
          f.passwords.hash = originalHash;
          expect(await f.service.registrationAvailability()).toEqual({
            enabled: true,
            reason: "available",
          });
          const session = await f.service.register(registration);
          expect(
            (await f.service.authenticateSession(session.token)).user.forcePasswordChange,
          ).toBe(false);
        } finally {
          finishHash();
          await f.close();
        }
      });
    },
  );
}

function record(): CompleteLocalRegistrationRecord {
  const userId = randomUUID();
  return {
    user: {
      id: userId,
      username: "rollback.user",
      normalizedUsername: "rollback.user",
      displayName: "Rollback",
      passwordHash: digest(password),
      forcePasswordChange: true,
      createdAt: now,
    },
    defaultRole: {
      projectId: DEFAULT_PROJECT_ID,
      roleId: "00000000-0000-7000-8100-000000000004",
      recordedAt: now,
    },
    session: {
      id: randomUUID(),
      tokenHash: digest(randomUUID()),
      createdAt: now,
      expiresAt: "2026-11-03T00:00:00.000Z",
    },
    audit: {
      id: randomUUID(),
      actorType: "user",
      actorId: userId,
      action: "auth.register",
      resourceType: "user",
      resourceId: userId,
      result: "succeeded",
      details: {},
      recordedAt: now,
    },
  };
}

async function fixture(mode: "lite" | "full") {
  let repository: IdentityAccessRepository;
  let close: () => Promise<void>;
  if (mode === "lite") {
    const directory = mkdtempSync(join(tmpdir(), "af-register-"));
    const handle = createSqliteDatabase({
      databasePath: join(directory, "db.sqlite"),
      migrationsFolder: resolve("packages/db/drizzle/sqlite"),
    });
    repository = new SqliteIdentityAccessRepository(handle);
    close = async () => {
      handle.close();
      rmSync(directory, { recursive: true, force: true });
    };
  } else {
    const admin = new Pool({ connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL, max: 1 });
    const schema = `register_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const handle = createPostgresDatabase({
      connectionString: url.toString(),
      migrationsFolder: resolve("packages/db/drizzle/postgresql"),
      poolMax: 4,
    });
    await handle.ready;
    repository = new PostgresIdentityAccessRepository(handle);
    close = async () => {
      await handle.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    };
  }
  const passwords = {
    hash: async (text: string) => digest(text),
    verify: async (text: string, hash: string) => digest(text) === hash,
  };
  const service = new IdentityAccessService(
    repository,
    passwords,
    {
      issue: randomUUID,
      hash: digest,
      verifyBootstrapToken: (token) => token === "fixture-bootstrap",
    },
    {
      available: false,
      encrypt: () => {
        throw new Error("No cipher required");
      },
      decrypt: () => {
        throw new Error("No cipher required");
      },
    },
    {
      authenticate: async () => {
        throw new Error("Registration must not query LDAP");
      },
      test: async () => {
        throw new Error("Registration must not probe LDAP");
      },
    },
    { now: () => new Date(now) },
    { next: randomUUID },
    24,
  );
  await service.initialize();
  return {
    service,
    repository,
    passwords,
    close,
    bootstrap: () =>
      service.bootstrap({
        bootstrapToken: "fixture-bootstrap",
        username: "admin",
        displayName: "Administrator",
        password,
      }),
  };
}
