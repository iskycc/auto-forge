import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DdtScope } from "@autoforge/domain";

/** Seed historical import results without parsing thousands of spreadsheets in a browser test. */
export async function insertDdtImportJobFixture(scope: DdtScope, fileCount: number) {
  const directory = process.env.AUTOFORGE_E2E_DATA_DIR;
  const postgresUrl = process.env.AUTOFORGE_E2E_POSTGRES_URL;
  const sqlite = directory
    ? new DatabaseSync(resolve(directory, "db", "autoforge.sqlite"))
    : undefined;
  if (!sqlite && !postgresUrl) throw new Error("DDT import fixture requires an E2E database.");
  const postgres = !sqlite
    ? (await import("@autoforge/db/postgres")).createPostgresDatabase({
        connectionString: postgresUrl!,
        migrationsFolder: resolve("packages/db/drizzle/postgresql"),
        poolMax: 1,
      })
    : undefined;
  await postgres?.ready;
  sqlite?.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  const execute = async (sql: string, values: Array<string | number>) => {
    if (sqlite) sqlite.prepare(sql).run(...values);
    else {
      let parameter = 0;
      await postgres!.pool.query(
        sql.replaceAll("?", () => `$${++parameter}`),
        values,
      );
    }
  };
  const jobId = `import-${randomUUID()}`;
  const recordedAt = "2026-10-19T00:00:00.000Z";
  try {
    await execute(
      `INSERT INTO ddt_import_jobs
       (id,project_id,project_version_id,test_stage_id,status,uploads_json,progress_percent,
        total_files,valid_files,total_rows,inserted_count,failed_files,created_at,updated_at)
       VALUES (?,?,?,?,'partially_succeeded','[]',100,?,?,?,?,1,?,?)`,
      [
        jobId,
        scope.projectId,
        scope.projectVersionId,
        scope.testStageId,
        fileCount,
        fileCount - 1,
        fileCount,
        fileCount - 1,
        recordedAt,
        recordedAt,
      ],
    );
    for (let start = 0; start < fileCount; start += 100) {
      const values: Array<string | number> = [];
      const rows: string[] = [];
      for (let index = start; index < Math.min(start + 100, fileCount); index += 1) {
        rows.push("(?,?,?,'batch.zip',?,?,1,?,?,?,?)");
        const number = String(index + 1).padStart(5, "0");
        const archiveDirectory = index === 0 ? `归档/${"很长的中文目录名称".repeat(16)}` : "归档";
        values.push(
          `${jobId}-${number}`,
          jobId,
          "upload",
          `${archiveDirectory}/结果-${number}.csv`,
          index === fileCount - 1 ? "failed" : "succeeded",
          index === fileCount - 1 ? 0 : 1,
          index === fileCount - 1 ? "最后一个文件的数据格式有误" : "",
          recordedAt,
          recordedAt,
        );
      }
      await execute(
        `INSERT INTO ddt_import_files
        (id,job_id,upload_id,file_name,archive_entry_name,status,row_count,inserted_count,error_summary,created_at,updated_at)
        VALUES ${rows.join(",")}`,
        values,
      );
    }
    return jobId;
  } finally {
    sqlite?.close();
    await postgres?.close();
  }
}
