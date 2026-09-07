import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityAccessService, type IdentityAccessRepository } from "@autoforge/application";
import type { AuditEvent, AuthenticatedIdentity } from "@autoforge/domain";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteIdentityAccessRepository } from "../src/sqlite-identity-access";
import { PostgresIdentityAccessRepository } from "../src/postgres-identity-access";

for (const engine of ["SQLite", "PostgreSQL"] as const) {
  describe.skipIf(engine === "PostgreSQL" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${engine} security audit contract`,
    () => {
      let repository: IdentityAccessRepository;
      let service: IdentityAccessService;
      let close: () => Promise<void>;
      const suffix = randomUUID();
      const timestamp = "2026-09-07T00:00:00.000Z";
      const projectId = `audit-project-${suffix}`;
      const actor: AuthenticatedIdentity = {
        user: {
          id: `audit-user-${suffix}`,
          username: `audit-${suffix}`,
          displayName: "审计测试人员",
          source: "local",
          status: "active",
          forcePasswordChange: false,
          failedLoginAttempts: 0,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        sessionId: "session",
        systemPermissions: ["audit.read", "audit.export"],
        projectPermissions: {},
      };
      const event = (
        sequence: number,
        action: string,
        overrides: Partial<AuditEvent> = {},
      ): AuditEvent => ({
        id: `${suffix}-${sequence}`,
        actorType: "user",
        actorId: actor.user.id,
        action,
        resourceType: "case_definition",
        resourceId: `case-${sequence}`,
        ...(action === "auth.login" ? {} : { projectId }),
        result: "succeeded",
        details: {},
        recordedAt: timestamp,
        ...overrides,
      });
      const records = [
        event(1, "case_definition.update", { details: { name: "支付用例 100%_完成" } }),
        event(2, "auth.login", {
          resourceType: "session",
          result: "rejected",
        }),
        event(3, "case_suite.create"),
        event(4, "execution_run.retry_scheduled"),
        event(5, "run_attempt.rerun"),
        event(6, "case_definition.delete", { projectId: `other-${suffix}` }),
        event(7, "auth.access_denied", {
          result: "rejected",
          details: { permission: "case.manage" },
        }),
      ];

      beforeAll(async () => {
        if (engine === "SQLite") {
          const directory = await mkdtemp(resolve(tmpdir(), "autoforge-audit-contract-"));
          const handle = createSqliteDatabase({
            databasePath: resolve(directory, "audit.db"),
            migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
          });
          repository = new SqliteIdentityAccessRepository(handle);
          close = async () => {
            handle.close();
            await rm(directory, { recursive: true, force: true });
          };
        } else {
          const handle = createPostgresDatabase({
            connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
            migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
          });
          await handle.ready;
          repository = new PostgresIdentityAccessRepository(handle);
          close = async () => {
            try {
              await handle.pool.query("DELETE FROM audit_events WHERE actor_id = ANY($1::text[])", [
                [actor.user.id, `missing-actor-${suffix}`],
              ]);
              await handle.pool.query("DELETE FROM projects WHERE id = ANY($1::text[])", [
                [projectId, `other-${suffix}`],
              ]);
              await handle.pool.query("DELETE FROM users WHERE id = $1", [actor.user.id]);
            } finally {
              await handle.close();
            }
          };
        }
        await repository.createLocalUser({
          id: actor.user.id,
          username: actor.user.username,
          normalizedUsername: actor.user.username,
          displayName: actor.user.displayName,
          passwordHash: "unused-test-hash",
          forcePasswordChange: false,
          createdAt: timestamp,
        });
        await repository.createProject({
          id: projectId,
          name: "审计项目",
          slug: `audit-${suffix}`,
          createdAt: timestamp,
        });
        await repository.createProject({
          id: `other-${suffix}`,
          name: "其他项目",
          slug: `other-${suffix}`,
          createdAt: timestamp,
        });
        for (const record of records) await repository.appendAudit(record);
        type Dependencies = ConstructorParameters<typeof IdentityAccessService>;
        service = new IdentityAccessService(
          repository,
          {} as Dependencies[1],
          {} as Dependencies[2],
          {} as Dependencies[3],
          {} as Dependencies[4],
          { now: () => new Date(timestamp) },
          { next: () => randomUUID() },
          8,
        );
      });
      afterAll(async () => {
        await close?.();
      });

      it("filters old operational events before filling pages and applies the same scope to exports", async () => {
        const input = { actorId: actor.user.id, projectId, limit: 2 };
        const first = await service.listAudit(actor, input);
        expect(first.items.map((item) => item.action)).toEqual([
          "auth.access_denied",
          "case_suite.create",
        ]);
        expect(first.nextCursor).toBeTruthy();
        const second = await service.listAudit(actor, { ...input, cursor: first.nextCursor! });
        expect(second.items.map((item) => item.action)).toEqual([
          "auth.login",
          "case_definition.update",
        ]);
        expect(second.nextCursor).toBeUndefined();
        const exported = await service.exportAudit(actor, {
          actorId: actor.user.id,
          projectId,
          maximumEvents: 20,
        });
        expect(exported.map((item) => item.id)).toEqual(
          [...first.items, ...second.items].map((item) => item.id),
        );
        expect(
          exported.every((item) => /[\u4e00-\u9fff]/u.test(String(item.details.eventDescription))),
        ).toBe(true);
      });

      it("cannot restore an excluded event with a direct action filter", async () => {
        expect(
          (
            await service.listAudit(actor, {
              actorId: actor.user.id,
              action: "run_attempt.rerun",
              limit: 10,
            })
          ).items,
        ).toEqual([]);
      });

      it("finds historical events by Chinese operation name and narrows by category", async () => {
        const result = await service.listAudit(actor, {
          actorId: actor.user.id,
          category: "case",
          query: "修改用例",
          limit: 10,
        });
        expect(result.items.map((item) => item.id)).toEqual([records[0]!.id]);
      });

      it("searches Chinese details with literal percent and underscore characters", async () => {
        expect(
          (await service.listAudit(actor, { actorId: actor.user.id, query: "支付用例", limit: 10 }))
            .items,
        ).toHaveLength(1);
        expect(
          (
            await service.listAudit(actor, { actorId: actor.user.id, query: "%_", limit: 10 })
          ).items.map((item) => item.id),
        ).toEqual([records[0]!.id]);
        expect(
          (
            await service.listAudit(actor, {
              actorId: actor.user.id,
              query: "no_match%",
              limit: 10,
            })
          ).items,
        ).toEqual([]);
      });

      it("searches historical actor names and records denial against a missing project safely", async () => {
        const matching = await service.listAudit(actor, {
          actorId: actor.user.id,
          query: "审计测试人员",
          limit: 10,
        });
        expect(matching.items).toHaveLength(5);
        await service.recordAccessDenial(
          {
            actorId: `missing-actor-${suffix}`,
            actorName: "审计测试人员",
            permission: "case.manage",
            projectId: `missing-${suffix}`,
          },
          `denial-${suffix}`,
        );
        const denied = await repository.listAudit({
          actorId: `missing-actor-${suffix}`,
          action: "auth.access_denied",
          query: `missing-${suffix}`,
          limit: 10,
        });
        expect(denied.items).toHaveLength(1);
        expect(denied.items[0]).toMatchObject({
          result: "rejected",
          details: { eventDescription: "越权访问被拒绝", targetProjectId: `missing-${suffix}` },
        });
        expect(denied.items[0]?.projectId).toBeUndefined();
      });

      it("keeps login and denied-access outcomes and enforces project auditor isolation", async () => {
        const scopedActor: AuthenticatedIdentity = {
          ...actor,
          systemPermissions: [],
          projectPermissions: { [projectId]: ["audit.read", "audit.export"] },
        };
        const page = await service.listAudit(scopedActor, { actorId: actor.user.id, limit: 20 });
        expect(page.items.map((item) => item.action)).toEqual([
          "auth.access_denied",
          "case_suite.create",
          "case_definition.update",
        ]);
        await expect(
          service.exportAudit(scopedActor, { projectId: `other-${suffix}`, maximumEvents: 20 }),
        ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
        const security = await service.listAudit(actor, {
          actorId: actor.user.id,
          category: "access",
          result: "rejected",
          limit: 10,
        });
        expect(security.items.map((item) => item.action)).toEqual([
          "auth.access_denied",
          "auth.login",
        ]);
      });
    },
  );
}
