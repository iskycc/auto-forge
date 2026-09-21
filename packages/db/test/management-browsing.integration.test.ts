import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteCaseCatalogRepository } from "../src/sqlite-case-catalog";
import { PostgresCaseCatalogRepository } from "../src/postgres-platform-repository";
import { SqliteWebhookRepository } from "../src/sqlite-webhook";
import { PostgresWebhookRepository } from "../src/postgres-webhook";
import { SqlitePlatformOperationsRepository } from "../src/sqlite-platform-operations";
import { PostgresPlatformOperationsRepository } from "../src/postgres-platform-operations";

const timestamp = "2026-09-22T00:00:00.000Z";
const projectId = "00000000-0000-7000-8000-000000000001";
async function fixture(mode: "sqlite" | "postgres") {
  if (mode === "sqlite") {
    const directory = await mkdtemp(join(tmpdir(), "autoforge-management-"));
    const handle = createSqliteDatabase({
      databasePath: join(directory, "test.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    return {
      catalog: new SqliteCaseCatalogRepository(handle),
      webhooks: new SqliteWebhookRepository(handle),
      operations: new SqlitePlatformOperationsRepository(handle),
      query: async (statement: string, values: Array<string | number> = []) => {
        handle.client.prepare(statement).run(...values);
      },
      close: async () => {
        handle.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const schema = `management_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const handle = createPostgresDatabase({
    connectionString: url.toString(),
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    poolMax: 2,
  });
  await handle.ready;
  return {
    catalog: new PostgresCaseCatalogRepository(handle),
    webhooks: new PostgresWebhookRepository(handle),
    operations: new PostgresPlatformOperationsRepository(handle),
    query: async (statement: string, values: Array<string | number> = []) => {
      let parameter = 0;
      await handle.pool.query(
        statement.replace(/\?/g, () => `$${++parameter}`),
        values,
      );
    },
    close: async () => {
      await handle.close();
      try {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    },
  };
}
for (const mode of ["sqlite", "postgres"] as const) {
  describe.skipIf(mode === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${mode} management browsing`,
    () => {
      it("browses more than 100 sources and objects without duplicates, metadata hydration or scope leaks", async () => {
        const context = await fixture(mode);
        try {
          for (let index = 0; index < 121; index++) {
            const id = `source-${String(index).padStart(4, "0")}`;
            await context.query(
              `INSERT INTO case_sources (id,display_name,original_file_name,object_key,sha256,size_bytes,class_count,method_count,status,warnings_json,inspection_json,created_at,updated_at)
            VALUES (?,?,?,?,?,10,1,1,'ready','[]',?,?,?)`,
              [
                id,
                index === 120 ? "Pay_100%" : `Test ${index}`,
                `test-${index}.jar`,
                `sources/${id}`,
                `digest-${index}`,
                "{}",
                timestamp,
                timestamp,
              ],
            );
          }
          const ids: string[] = [];
          let cursor: string | undefined;
          do {
            const rows = await context.catalog.listSources(
              50,
              [projectId],
              cursor ? { cursor } : {},
            );
            ids.push(...rows.map((row) => row.id));
            cursor = rows.length === 50 ? rows.at(-1)!.id : undefined;
          } while (cursor);
          expect(ids).toHaveLength(121);
          expect(new Set(ids).size).toBe(121);
          expect(
            (await context.catalog.listSources(50, [projectId], { query: "pay_100%" })).map(
              (row) => row.id,
            ),
          ).toEqual(["source-0120"]);
          expect(await context.catalog.listSources(50, [], {})).toEqual([]);
          expect(await context.catalog.listSources(50, ["other"], {})).toEqual([]);
          const objects: string[] = [];
          do {
            const page = await context.catalog.listSourceObjectsPage(
              { limit: 50, ...(cursor ? { cursor } : {}) },
              [projectId],
            );
            objects.push(...page.items.map((item) => item.objectKey));
            cursor = page.nextCursor;
          } while (cursor);
          expect(objects).toHaveLength(121);
          expect(new Set(objects).size).toBe(121);
        } finally {
          await context.close();
        }
      });
      it("pages delivery history using timestamp and id, and applies filters before limiting", async () => {
        const context = await fixture(mode);
        try {
          await context.query(
            `INSERT INTO case_suites (id,project_id,name,description,version,status,enabled,revision,policy_json,created_at,updated_at) VALUES ('suite',?,'Suite','',1,'active',TRUE,1,'{}',?,?)`,
            [projectId, timestamp, timestamp],
          );
          await context.query(
            `INSERT INTO run_batches (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,environment_json,total_runs,project_id,created_at,updated_at) VALUES ('batch',1,'suite','Suite',1,'succeeded',0,'[]',1,?,?,?)`,
            [projectId, timestamp, timestamp],
          );
          for (let index = 0; index < 41; index++) {
            const id = `delivery-${String(index).padStart(3, "0")}`;
            await context.webhooks.createConfiguration({
              id: `hook-${index}`,
              projectId,
              name: `Hook ${index}`,
              normalizedName: `hook ${index}`,
              description: "",
              targetUrl: "http://example.test",
              method: "GET",
              enabled: true,
              recordedAt: timestamp,
            });
            await context.query(
              `INSERT INTO webhook_deliveries (id,webhook_id,webhook_name,batch_id,request_url,request_method,status,attempts,available_at,created_at,updated_at) VALUES (?,?,?,'batch','http://example.test','GET',?,0,?,?,?)`,
              [
                id,
                `hook-${index}`,
                "Hook",
                index % 2 ? "failed" : "succeeded",
                timestamp,
                timestamp,
                timestamp,
              ],
            );
          }
          const first = await context.webhooks.listDeliveries(projectId, 30);
          const last = first.at(-1)!;
          const second = await context.webhooks.listDeliveries(projectId, 30, {
            cursor: { createdAt: last.createdAt, id: last.id },
          });
          expect(first).toHaveLength(30);
          expect(second).toHaveLength(11);
          expect(new Set([...first, ...second].map((item) => item.id)).size).toBe(41);
          expect(await context.webhooks.listDeliveries("other", 30)).toEqual([]);
          const failed = await context.webhooks.listDeliveries(projectId, 30, { status: "failed" });
          expect(failed).toHaveLength(20);
          expect(failed.every((item) => item.status === "failed")).toBe(true);
          expect(
            await context.webhooks.listDeliveries(projectId, 30, { webhookId: "hook-1" }),
          ).toHaveLength(1);
        } finally {
          await context.close();
        }
      });
      it("filters service accounts before bounded paging and directly resolves token issuers", async () => {
        const context = await fixture(mode);
        try {
          await context.query(
            "INSERT INTO users (id,username,normalized_username,display_name,source,status,created_at,updated_at) VALUES ('account-owner','owner','owner','Owner','local','active',?,?)",
            [timestamp, timestamp],
          );
          for (let index = 0; index < 53; index++) {
            await context.operations.createServiceAccount({
              id: `account-${String(index).padStart(3, "0")}`,
              name: `Bot ${index}`,
              description: "Automation",
              status: index % 2 ? "active" : "disabled",
              systemPermissions: [],
              projectPermissions: { [projectId]: ["run.read"] },
              createdBy: "account-owner",
              createdAt: timestamp,
              updatedAt: timestamp,
              revision: 1,
            });
          }
          const first = await context.operations.listServiceAccounts({ limit: 50 });
          const second = await context.operations.listServiceAccounts({
            limit: 50,
            cursor: first.at(-1)!.id,
          });
          expect(first).toHaveLength(50);
          expect(second).toHaveLength(3);
          expect(new Set([...first, ...second].map((account) => account.id)).size).toBe(53);
          expect(
            await context.operations.listServiceAccounts({
              limit: 50,
              query: "bot 5",
              status: "active",
            }),
          ).toHaveLength(2);
          expect(
            await context.operations.listServiceAccounts({ limit: 1, id: "account-000" }),
          ).toMatchObject([{ id: "account-000" }]);
        } finally {
          await context.close();
        }
      });
      it("rejects outdated retention confirmation in the repository even when no candidates remain", async () => {
        const context = await fixture(mode);
        try {
          await context.operations.ensureRetentionPolicies([
            {
              category: "queue",
              retentionDays: 30,
              minimumDays: 1,
              maximumDays: 730,
              revision: 2,
              updatedAt: timestamp,
            },
          ]);
          await expect(
            context.operations.executeRetention({
              category: "queue",
              cutoffAt: "2026-08-01T00:00:00.000Z",
              limit: 10,
              recordedAt: timestamp,
              expectedRevision: 1,
            }),
          ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
          await expect(
            context.operations.executeRetention({
              category: "queue",
              cutoffAt: "2026-08-01T00:00:00.000Z",
              limit: 10,
              recordedAt: timestamp,
              expectedRevision: 2,
            }),
          ).resolves.toMatchObject({ deletedRecords: 0 });
        } finally {
          await context.close();
        }
      });
    },
  );
}
