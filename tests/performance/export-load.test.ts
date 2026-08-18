import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  createAttemptLogStore,
  createSqliteDatabase,
  SqliteAttemptLogShareRepository,
  SqliteExecutionControlRepository,
  SqliteRunBatchRepository,
} from "@autoforge/db/sqlite";
import { buildRunBatchExportWorkbook } from "@/export-workbook";
// exceljs 只安装在 apps/web，运行时由 vitest.performance.config.ts 别名到该副本，
// 类型由 export-workbook-shim.d.ts 的 ambient 声明提供。
import ExcelJS from "exceljs";
import { afterAll, describe, expect, it } from "vitest";

import { AttemptLogShareService } from "../../packages/application/src/attempt-log-shares";
import { buildRunBatchExportRows } from "../../packages/application/src/export-run-batch-results";

// 需求验收：导出支持 5 万+ 数据行且耗时不超过 1 分钟。
// 覆盖完整链路：批次详情读取（含 attempts 子查询）、行构建、批量日志公开访问链接、xlsx 生成。

const RUN_COUNT = 50_000;
const BATCH_ID = "00000000-0000-4000-8000-0000000e0001";
const baselineTimestamp = "2026-08-17T00:00:00.000Z";
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("run batch export performance", () => {
  it(`exports ${RUN_COUNT.toLocaleString()} rows end-to-end within 60 seconds`, async () => {
    const directory = await temporaryDirectory("autoforge-export-load-");
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "export.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../../packages/db/drizzle/sqlite"),
    });
    const attemptLogs = createAttemptLogStore(resolve(directory, "attempt-logs"));
    try {
      seedLoadFixture(handle.client, RUN_COUNT);

      const batches = new SqliteRunBatchRepository(handle);
      const shares = new AttemptLogShareService(
        new SqliteAttemptLogShareRepository(handle),
        batches,
        new SqliteExecutionControlRepository(handle, attemptLogs),
        {
          issue: () => randomBytes(32).toString("base64url"),
          hash: (value) => createHash("sha256").update(value).digest("hex"),
        },
        { now: () => new Date("2026-08-17T12:00:00.000Z") },
        { next: shareIdGenerator() },
      );

      const startedAt = performance.now();
      const details = await batches.get(BATCH_ID);
      expect(details).not.toBeNull();
      const rows = buildRunBatchExportRows(details!, {
        scope: "final",
        outcomes: ["succeeded", "failed", "timed_out", "cancelled", "blocked"],
      });
      const attemptIds = rows.flatMap((row) => (row.attemptId ? [row.attemptId] : []));
      const tokens = await shares.ensureSharesForAttemptsInBatch(attemptIds, BATCH_ID, "user-load");
      const shareLinks = new Map(
        [...tokens.entries()].map(([attemptId, token]) => [
          attemptId,
          `http://localhost/share/attempt-log/${token}`,
        ]),
      );
      const { buffer } = await buildRunBatchExportWorkbook({
        batchId: BATCH_ID,
        scope: "final",
        rows,
        shareLinks,
      });
      const durationMs = performance.now() - startedAt;

      expect(rows).toHaveLength(RUN_COUNT);
      expect(tokens.size).toBe(RUN_COUNT);

      // 读回生成的 xlsx 校验表头与行数，确保不是只计时了空壳。
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const sheet = workbook.getWorksheet("执行结果");
      expect(sheet).toBeDefined();
      expect(sheet!.getCell("A1").value).toBe("用例路径");
      expect(sheet!.getCell("B1").value).toBe("名称");
      expect(sheet!.getCell("H1").value).toBe("日志链接");
      expect(sheet!.actualRowCount).toBe(RUN_COUNT + 1);
      // 日志公开访问链接列对每一行都有值。
      expect(sheet!.getCell(`H${RUN_COUNT + 1}`).value).toBeTruthy();

      expect(durationMs).toBeLessThan(60_000);
      recordMetric("run-batch-export", durationMs, {
        rows: RUN_COUNT,
        xlsxBytes: buffer.byteLength,
      });
    } finally {
      attemptLogs.close();
      handle.close();
    }
  });
});

/** 1 个批次 + RUN_COUNT 条 run/attempt，约 20% 失败，其余成功。 */
function seedLoadFixture(
  client: { transaction<T>(fn: () => T): () => T; prepare(sql: string): StatementLike },
  runCount: number,
): void {
  client
    .prepare(
      `INSERT INTO runners
       (id, credential_hash, name, disabled, draining, os, architecture, agent_version,
        protocol_version, labels_json, capabilities_json, max_concurrency, busy_slots,
        last_seen_at, created_at, updated_at)
       VALUES ('runner-load', 'hash', 'Load Runner', 0, 0, 'linux', 'amd64', '0.4.0',
               1, '{}', '[]', 2, 0, '${baselineTimestamp}', '${baselineTimestamp}',
               '${baselineTimestamp}')`,
    )
    .run();
  client
    .prepare(
      `INSERT INTO run_batches
       (id, suite_id, suite_name, suite_version, status, retry_limit, total_runs,
        environment_json, created_at, updated_at)
       VALUES ('${BATCH_ID}', 'suite-load', 'Load', 1, 'succeeded', 0, ${runCount}, '[]',
               '${baselineTimestamp}', '${baselineTimestamp}')`,
    )
    .run();

  const insertRun = client.prepare(
    `INSERT INTO execution_runs
       (id, batch_id, case_definition_id, case_version, display_name, class_name,
        parameters_json, status, attempt_count, terminal_outcome, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, '{}', ?, 1, ?, '${baselineTimestamp}', '${baselineTimestamp}')`,
  );
  const insertAttempt = client.prepare(
    `INSERT INTO run_attempts
       (id, execution_run_id, runner_id, attempt_number, status, scheduling_score,
        started_at, finished_at, outcome, result_summary, duration_ms, created_at)
     VALUES (?, ?, 'runner-load', 1, ?, 1.0, '${baselineTimestamp}', '${baselineTimestamp}',
             ?, ?, ?, '${baselineTimestamp}')`,
  );

  client.transaction(() => {
    for (let index = 0; index < runCount; index += 1) {
      const outcome = index % 5 === 0 ? "failed" : "succeeded";
      const runId = `run-${index}`;
      insertRun.run(
        runId,
        BATCH_ID,
        `case-${index}`,
        `Case ${index}`,
        `load.fixture.Test${index % 500}.case${index}`,
        outcome,
        outcome,
      );
      insertAttempt.run(
        `attempt-${index}`,
        runId,
        outcome,
        outcome,
        outcome === "failed" ? "java.lang.AssertionError: boom" : null,
        1_000 + (index % 500),
      );
    }
  })();
}

function shareIdGenerator(): () => string {
  let counter = 0;
  return () => `share-${counter++}`;
}

type StatementLike = {
  // 方法签名保持双变：better-sqlite3 会按占位符数量推断不同的参数元组。
  run(...parameters: unknown[]): unknown;
};

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

function recordMetric(name: string, durationMs: number, scale: Record<string, number>): void {
  process.stdout.write(
    `${JSON.stringify({ metric: name, durationMs: Math.round(durationMs), ...scale })}\n`,
  );
}
