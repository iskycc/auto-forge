import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ddtScopeClearPageSchema, ddtScopeClearPreviewSchema } from "@autoforge/contracts";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { createSqliteDatabase } from "../../../packages/db/src/database";
import { createPostgresDatabase } from "../../../packages/db/src/postgres-database";
import { SqliteProjectStructureRepository } from "../../../packages/db/src/sqlite-project-structure";
import { PostgresProjectStructureRepository } from "../../../packages/db/src/postgres-project-structure";
import { WorkerPool } from "./worker-pool";

for (const mode of ["lite", "full"] as const) {
  describe.skipIf(mode === "full" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${mode} DDT clearing maintenance thread`,
    () => {
      it("previews and clears the scope without object storage or foreground work", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "ddt-clear-worker-"));
        const migrationsFolder = resolve(
          "packages/db/drizzle",
          mode === "lite" ? "sqlite" : "postgresql",
        );
        const databasePath = resolve(directory, "db.sqlite");
        const sqlite =
          mode === "lite" ? createSqliteDatabase({ databasePath, migrationsFolder }) : undefined;
        const postgres =
          mode === "full"
            ? createPostgresDatabase({
                connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
                migrationsFolder,
              })
            : undefined;
        await postgres?.ready;
        const structures = sqlite
          ? new SqliteProjectStructureRepository(sqlite)
          : new PostgresProjectStructureRepository(postgres!);
        const scope = {
          projectId: DEFAULT_PROJECT_ID,
          projectVersionId: randomUUID(),
          testStageId: randomUUID(),
        };
        const now = "2026-10-01T00:00:00.000Z";
        const requestId = randomUUID();
        const pool = new WorkerPool(
          {
            mode,
            dataDirectory: directory,
            migrationsFolder,
            attemptLogsDirectory: resolve(directory, "logs"),
            caseExecutionTimeoutSeconds: 60,
            artifactCollectionEnabled: false,
            scheduler: {
              maximumCpuUtilizationPercent: 90,
              maximumMemoryUtilizationPercent: 90,
              maximumLoadPerCpu: 2,
              metricsMaximumAgeSeconds: 60,
              projectMaximumConcurrency: 128,
              priorityAgingIntervalMinutes: 1,
            },
            ...(sqlite
              ? { sqlite: { databasePath } }
              : {
                  full: {
                    databaseUrl: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
                    databasePoolMax: 4,
                    minio: {
                      endPoint: "127.0.0.1",
                      port: 1,
                      useSSL: false,
                      accessKey: "unused-key",
                      secretKey: "unused-secret",
                      bucket: "unused-bucket",
                      region: "us-east-1",
                    },
                  },
                }),
          },
          1,
          5000,
        );
        try {
          await structures.createVersion({
            id: scope.projectVersionId,
            projectId: scope.projectId,
            name: scope.projectVersionId,
            normalizedName: scope.projectVersionId,
            recordedAt: now,
          });
          await structures.createStage({
            ...scope,
            id: scope.testStageId,
            name: "stage",
            normalizedName: "stage",
            description: "",
            recordedAt: now,
          });
          const statement =
            "INSERT INTO ddt_cases(id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,created_at,updated_at) VALUES (?,?,?,?,'CASE','case','SR','sr','standard','{}',?,?)";
          const values = [
            randomUUID(),
            scope.projectId,
            scope.projectVersionId,
            scope.testStageId,
            now,
            now,
          ];
          if (sqlite) sqlite.client.prepare(statement).run(...values);
          else {
            let parameter = 0;
            await postgres!.pool.query(
              statement.replaceAll("?", () => `$${++parameter}`),
              values,
            );
          }
          const signal = new AbortController().signal;
          const preview = ddtScopeClearPreviewSchema.parse(
            await pool.clearDdtScope({ operation: "preview", scope }, signal),
          );
          expect(preview).toMatchObject({ activeCases: 1, recycledCases: 0, affectedSuites: 0 });
          const input = {
            operation: "clear",
            scope,
            input: { clearedBefore: preview.clearedBefore, confirmation: "清空DDT用例" },
            actor: { principalId: "maintenance-test" },
            requestId,
          };
          expect(
            ddtScopeClearPageSchema.parse(await pool.clearDdtScope(input, signal)),
          ).toMatchObject({ phase: "cases", deletedCases: 1, hasMore: true });
          expect(
            ddtScopeClearPageSchema.parse(await pool.clearDdtScope(input, signal)),
          ).toMatchObject({ phase: "done", hasMore: false });
        } finally {
          await pool.close();
          if (sqlite) sqlite.close();
          if (postgres) {
            await postgres.pool.query("DELETE FROM audit_events WHERE request_id=$1", [requestId]);
            await postgres.pool.query("DELETE FROM test_stages WHERE id=$1", [scope.testStageId]);
            await postgres.pool.query("DELETE FROM project_versions WHERE id=$1", [
              scope.projectVersionId,
            ]);
            await postgres.close();
          }
          await rm(directory, { recursive: true, force: true });
        }
      }, 30_000);
    },
  );
}
