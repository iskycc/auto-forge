import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type {
  IdentityAccessRepository,
  PlatformOperationsRepository,
} from "@autoforge/application";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqlitePlatformOperationsRepository } from "../src/sqlite-platform-operations";
import { PostgresPlatformOperationsRepository } from "../src/postgres-platform-operations";
import { SqliteIdentityAccessRepository } from "../src/sqlite-identity-access";
import { PostgresIdentityAccessRepository } from "../src/postgres-identity-access";

const now = "2026-09-30T00:00:00.000Z";
for (const mode of ["lite", "full"] as const) {
  describe.skipIf(mode === "full" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${mode} authorization persistence`,
    () => {
      it("separates search resource kinds and preserves the export's original authorization scope", async () => {
        const fixture = await openFixture(mode);
        try {
          for (const kind of ["case", "suite", "batch", "run"] as const) {
            const result = await fixture.operations.globalSearch({
              query: "AuthFixture",
              limit: 20,
              projectIds: ["project-a"],
              kinds: [kind],
            });
            expect(result.items.map((item) => item.kind)).toEqual([kind]);
            expect(result.items.every((item) => item.projectId === "project-a")).toBe(true);
            expect(
              await fixture.operations.globalSearch({
                query: "AuthFixture",
                limit: 20,
                projectIds: ["project-b"],
                kinds: [kind],
              }),
            ).toEqual({ items: [] });
          }
          expect(
            await fixture.operations.globalSearch({ query: "AuthFixture", limit: 20, kinds: [] }),
          ).toEqual({ items: [] });
          await fixture.operations.createAnalyticsExportJob({
            job: {
              id: "export",
              requestedBy: "user-a",
              filter: {},
              format: "csv",
              status: "queued",
              progressPercent: 0,
              createdAt: now,
              updatedAt: now,
            },
            projectIds: ["project-a"],
            idempotencyKey: "export",
            dispatchJob: {
              schemaVersion: 1,
              messageId: "export-message",
              runId: "export",
              attempt: 1,
              createdAt: now,
              priority: 0,
              deduplicationKey: "export",
              kind: "analytics-export",
              payload: { exportId: "export" },
            },
          });
          expect(await fixture.operations.getAnalyticsExportScope("export", "user-a")).toEqual({
            filter: {},
            projectIds: ["project-a"],
          });
          expect(await fixture.operations.getAnalyticsExportScope("export", "user-b")).toBeNull();
        } finally {
          await fixture.close();
        }
      });

      it("keeps a recovery administrator when role removals race and rolls back a destructive permission edit", async () => {
        const fixture = await openFixture(mode);
        try {
          for (const userId of ["user-a", "user-b"]) {
            await fixture.identities.createRole({
              id: userId,
              key: userId,
              name: userId,
              description: "Recovery",
              scope: "system",
              permissions: ["user.manage", "role.manage"],
              createdAt: now,
            });
            await fixture.identities.assignSystemRole(userId, userId, "user-a", now);
          }
          const results = await Promise.allSettled([
            fixture.identities.removeSystemRole("user-a", "user-a", now),
            fixture.identities.removeSystemRole("user-b", "user-b", now),
          ]);
          expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
          const rejected = results.find((result) => result.status === "rejected");
          expect(rejected).toMatchObject({ reason: { code: "LAST_ADMIN_REQUIRED" } });
          const [remaining] = await fixture.identities.listSystemRoleBindingsForActiveUsers();
          expect(remaining).toBeDefined();
          await expect(
            fixture.identities.updateRole({
              id: remaining!.roleId,
              scope: "project",
              updatedAt: now,
            }),
          ).rejects.toMatchObject({ code: "ROLE_SCOPE_INVALID" });
          await expect(
            fixture.identities.updateRole({ id: remaining!.roleId, active: false, updatedAt: now }),
          ).rejects.toMatchObject({ code: "LAST_ADMIN_REQUIRED" });
          await expect(
            fixture.identities.updateRole({
              id: remaining!.roleId,
              permissions: ["user.read"],
              updatedAt: now,
            }),
          ).rejects.toMatchObject({ code: "LAST_ADMIN_REQUIRED" });
          expect((await fixture.identities.findRole(remaining!.roleId))?.permissions).toContain(
            "role.manage",
          );
          await expect(
            fixture.identities.updateUserStatus(remaining!.userId, "disabled", now),
          ).rejects.toMatchObject({ code: "LAST_ADMIN_REQUIRED" });
        } finally {
          await fixture.close();
        }
      });
    },
  );
}

async function openFixture(mode: "lite" | "full"): Promise<{
  identities: IdentityAccessRepository;
  operations: PlatformOperationsRepository;
  close(): Promise<void>;
}> {
  if (mode === "lite") {
    const directory = mkdtempSync(join(tmpdir(), "autoforge-auth-"));
    const handle = createSqliteDatabase({
      databasePath: join(directory, "db.sqlite"),
      migrationsFolder: resolve("packages/db/drizzle/sqlite"),
    });
    handle.client.exec(seed);
    return {
      identities: new SqliteIdentityAccessRepository(handle),
      operations: new SqlitePlatformOperationsRepository(handle),
      close: async () => {
        handle.close();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  }
  const administration = new Pool({
    connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL,
    max: 1,
  });
  const schema = `auth_${randomUUID().replaceAll("-", "")}`;
  await administration.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const handle = createPostgresDatabase({
    connectionString: url.toString(),
    migrationsFolder: resolve("packages/db/drizzle/postgresql"),
    poolMax: 4,
  });
  await handle.ready;
  await handle.pool.query(seed);
  return {
    identities: new PostgresIdentityAccessRepository(handle),
    operations: new PostgresPlatformOperationsRepository(handle),
    close: async () => {
      await handle.close();
      await administration.query(`DROP SCHEMA ${schema} CASCADE`);
      await administration.end();
    },
  };
}

const seed = `
INSERT INTO users (id,username,normalized_username,display_name,source,status,force_password_change,failed_login_attempts,created_at,updated_at,version)
VALUES ('user-a','auth-a','auth-a','A','local','active',FALSE,0,'${now}','${now}',1), ('user-b','auth-b','auth-b','B','local','active',FALSE,0,'${now}','${now}',1);
INSERT INTO projects (id,name,slug,is_default,archived,created_at,updated_at,owner_user_id)
VALUES ('project-a','AuthFixture','auth-a',FALSE,FALSE,'${now}','${now}','user-a');
INSERT INTO project_versions (id,project_id,name,normalized_name,status,revision,created_at,updated_at)
VALUES ('version','project-a','v1','v1','active',1,'${now}','${now}');
INSERT INTO test_stages (id,project_id,project_version_id,name,normalized_name,description,position,status,revision,created_at,updated_at)
VALUES ('stage','project-a','version','SIT','sit','',1,'active',1,'${now}','${now}');
INSERT INTO case_suites (id,project_id,name,description,version,status,enabled,revision,policy_json,created_by,updated_by,created_at,updated_at)
VALUES ('suite','project-a','AuthFixture','',1,'active',TRUE,1,'{}','user-a','user-a','${now}','${now}');
INSERT INTO case_sources (id,project_id,project_version_id,test_stage_id,display_name,original_file_name,object_key,sha256,size_bytes,class_count,method_count,status,warnings_json,inspection_json,authoritative,lifecycle_status,revision,created_at,updated_at)
VALUES ('source','project-a','version','stage','AuthFixture','auth.jar','jars/auth','${"a".repeat(64)}',10,1,1,'ready','[]','{}',TRUE,'active',1,'${now}','${now}');
INSERT INTO case_definitions (id,project_id,project_version_id,test_stage_id,source_id,class_name,package_name,display_name,description,tags_json,parameters_json,enabled,archived,revision,groups_json,current_version,created_at,updated_at)
VALUES ('case','project-a','version','stage','source','com.AuthFixture','com','AuthFixture','','[]','{}',TRUE,FALSE,1,'[]',1,'${now}','${now}');
INSERT INTO run_batches (id,suite_id,suite_name,suite_version,status,retry_limit,environment_json,secret_bindings_json,total_runs,project_id,priority,created_at,updated_at)
VALUES ('batch','suite','AuthFixture',1,'failed',0,'[]','[]',1,'project-a',0,'${now}','${now}');
INSERT INTO execution_runs (id,batch_id,case_definition_id,case_version,display_name,class_name,parameters_json,status,attempt_count,created_at,updated_at)
VALUES ('run','batch','case',1,'AuthFixture','com.AuthFixture','{}','failed',0,'${now}','${now}');
`;
