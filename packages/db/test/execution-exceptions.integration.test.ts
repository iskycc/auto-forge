import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { ADAPTER_FAILURE_RESULT_CODES, aggregateBatchStatus } from "@autoforge/domain";
import type { RunBatchRepository } from "@autoforge/application";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";

const timestamp = "2026-10-06T00:00:00.000Z";
const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
type Fixture = {
  batches: RunBatchRepository;
  insert(table: string, fields: Record<string, string | number | boolean | null>): Promise<void>;
  close(): Promise<void>;
};
async function createFixture(dialect: "sqlite" | "postgresql"): Promise<Fixture> {
  const directory = await mkdtemp(resolve(tmpdir(), "execution-exceptions-"));
  const handle =
    dialect === "sqlite"
      ? createSqliteDatabase({
          databasePath: resolve(directory, "test.sqlite"),
          migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
        })
      : null;
  const schema = `exceptions_${randomUUID().replaceAll("-", "")}`;
  const admin = handle ? null : new Pool({ connectionString: postgresUrl!, max: 1 });
  if (admin) await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(postgresUrl ?? "postgresql://localhost/test");
  url.searchParams.set("options", `-c search_path=${schema}`);
  const pg = handle
    ? null
    : createPostgresDatabase({
        connectionString: url.toString(),
        migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
        poolMax: 1,
      });
  if (pg) await pg.ready;
  const fixture: Fixture = {
    batches: handle ? new SqliteRunBatchRepository(handle) : new PostgresRunBatchRepository(pg!),
    insert: async (table, fields) => {
      const placeholders = Object.keys(fields).map((_, index) => (handle ? "?" : `$${index + 1}`));
      const statement = `INSERT INTO ${table} (${Object.keys(fields).join(",")}) VALUES (${placeholders.join(",")})`;
      if (handle)
        handle.client
          .prepare(statement)
          .run(
            ...Object.values(fields).map((value) =>
              typeof value === "boolean" ? Number(value) : value,
            ),
          );
      else await pg!.pool.query(statement, Object.values(fields));
    },
    close: async () => {
      if (handle) handle.close();
      else {
        await pg!.close();
        await admin!.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin!.end();
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
  await fixture.insert("run_batches", {
    id: "batch",
    suite_id: "suite",
    suite_name: "异常诊断",
    suite_version: 1,
    status: "failed",
    retry_limit: 0,
    environment_json: "[]",
    total_runs: 1,
    created_at: timestamp,
    updated_at: timestamp,
  });
  await fixture.insert("runners", {
    id: "runner",
    name: "Runner",
    credential_hash: "fixture-hash",
    disabled: false,
    os: "linux",
    architecture: "amd64",
    agent_version: "fixture",
    protocol_version: 1,
    labels_json: "[]",
    capabilities_json: "[]",
    max_concurrency: 1,
    busy_slots: 0,
    last_seen_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  });
  return fixture;
}
async function addRun(
  fixture: Fixture,
  id: string,
  code: string | null,
  status = "failed",
  round = 1,
) {
  await fixture.insert("execution_runs", {
    id,
    batch_id: "batch",
    case_definition_id: id,
    case_version: 1,
    display_name: `用例 ${id}`,
    class_name: `com.example.${id}`,
    status,
    attempt_count: 0,
    terminal_outcome: code === "QUEUE_TIMEOUT" ? "timed_out" : status,
    terminal_reason_code: code,
    execution_round: round,
    created_at: timestamp,
    updated_at: timestamp,
  });
}
async function addAttempt(
  fixture: Fixture,
  runId: string,
  number: number,
  code: string | null,
  status: string,
  summary = "执行原因",
) {
  await fixture.insert("run_attempts", {
    id: `${runId}-${number}`,
    execution_run_id: runId,
    runner_id: "runner",
    attempt_number: number,
    execution_round: 1,
    status,
    outcome: status,
    result_code: code,
    result_summary: summary,
    scheduling_score: 1,
    created_at: timestamp,
    finished_at: timestamp,
  });
}
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgresUrl)(
    `${dialect} execution exception causes`,
    () => {
      it("finds queue timeout evidence even though no attempt appears in round results", async () => {
        const fixture = await createFixture(dialect);
        try {
          await addRun(fixture, "queued", "QUEUE_TIMEOUT");
          const overview = await fixture.batches.getDetailOverview("batch");
          expect(overview!.roundSummaries[0]).toMatchObject({ timedOut: 0, notExecuted: 1 });
          const records = await fixture.batches.readExceptionRecords({
            batchId: "batch",
            limit: 51,
          });
          expect(records.items).toMatchObject([
            {
              kind: "run",
              round: 1,
              runId: "queued",
              resultCode: "QUEUE_TIMEOUT",
              affectsBatchStatus: true,
            },
          ]);
          expect(
            aggregateBatchStatus([{ status: "failed", terminalReasonCode: "QUEUE_TIMEOUT" }]),
          ).toBe("failed");
        } finally {
          await fixture.close();
        }
      });
      it("does not call normal assertion, configuration or skip failures execution exceptions", async () => {
        const fixture = await createFixture(dialect);
        try {
          for (const [index, code] of ADAPTER_FAILURE_RESULT_CODES.entries()) {
            await addRun(fixture, `normal-${index}`, code);
            await addAttempt(fixture, `normal-${index}`, 1, code, "failed");
          }
          const records = await fixture.batches.readExceptionRecords({
            batchId: "batch",
            limit: 51,
          });
          expect(records.items).toEqual([]);
          expect(records.completions).toMatchObject([
            { status: "failed", abnormal: false, count: ADAPTER_FAILURE_RESULT_CODES.length },
          ]);
        } finally {
          await fixture.close();
        }
      });
      it("keeps recovered infrastructure history separate from the final batch cause and pages all evidence", async () => {
        const fixture = await createFixture(dialect);
        try {
          await addRun(fixture, "recovered", "TESTNG_SUCCEEDED", "succeeded");
          await addAttempt(fixture, "recovered", 1, "LEASE_EXPIRED", "timed_out");
          await addAttempt(fixture, "recovered", 2, "TESTNG_SUCCEEDED", "succeeded");
          for (let index = 0; index < 55; index++)
            await addRun(fixture, `timeout-${index}`, "QUEUE_TIMEOUT");
          const first = await fixture.batches.readExceptionRecords({ batchId: "batch", limit: 51 });
          expect(first.items).toHaveLength(51);
          expect(first.items.find((item) => item.id === "attempt:recovered-1")).toMatchObject({
            affectsBatchStatus: false,
          });
          const last = first.items.at(-1)!;
          const rest = await fixture.batches.readExceptionRecords({
            batchId: "batch",
            limit: 51,
            after: { id: last.id, occurredAt: last.occurredAt },
          });
          expect(rest.items).toHaveLength(5);
          expect(new Set([...first.items, ...rest.items].map((item) => item.id)).size).toBe(56);
          const preview = await fixture.batches.readExceptionRecords({
            batchId: "batch",
            scope: "terminal",
            limit: 4,
          });
          expect(preview.items).toHaveLength(4);
          expect(preview.items.every((item) => item.affectsBatchStatus)).toBe(true);
          expect(preview.items.map((item) => item.resultCode)).toEqual(
            Array(4).fill("QUEUE_TIMEOUT"),
          );
          expect(preview.completions).toEqual(first.completions);
        } finally {
          await fixture.close();
        }
      });
      it("includes recovery failure descriptions and the affected cases without exposing credentials", async () => {
        const fixture = await createFixture(dialect);
        try {
          await addRun(fixture, "blocked", "JENKINS_ROUND_RECOVERY_FAILED");
          await addAttempt(fixture, "blocked", 1, "TESTNG_ASSERTIONS_FAILED", "failed");
          await fixture.insert("run_batch_round_recoveries", {
            batch_id: "batch",
            rule_id: "rule",
            after_round: 1,
            next_round: 2,
            jenkins_job_url: "http://jenkins/job/test",
            api_key_ciphertext: "secret-ciphertext",
            wait_minutes: 0,
            status: "failed",
            error_message: "恢复服务连接失败",
            available_at: timestamp,
            created_at: timestamp,
            updated_at: timestamp,
          });
          const records = await fixture.batches.readExceptionRecords({
            batchId: "batch",
            limit: 51,
          });
          expect(records.items).toHaveLength(2);
          expect(records.items.find((item) => item.kind === "recovery")).toMatchObject({
            round: 1,
            summary: "恢复服务连接失败",
            affectsBatchStatus: true,
          });
          expect(JSON.stringify(records)).not.toContain("secret-ciphertext");
        } finally {
          await fixture.close();
        }
      });
      it("identifies each final abnormal attempt once and retains recovered faults as history", async () => {
        const fixture = await createFixture(dialect);
        try {
          const codes = [
            "EXECUTION_TIMEOUT",
            "UPLOAD_TIMEOUT",
            "ASSIGNMENT_CLAIM_TIMEOUT",
            "PROCESS_START_FAILED",
            "FUTURE_RUNNER_ERROR",
          ];
          for (const code of codes) {
            await addRun(fixture, code, code);
            await addAttempt(fixture, code, 1, code, "failed");
          }
          await addRun(fixture, "recovered-failure", "TESTNG_CONFIGURATION_FAILED");
          await addAttempt(fixture, "recovered-failure", 1, "PROCESS_START_FAILED", "failed");
          await addAttempt(
            fixture,
            "recovered-failure",
            2,
            "TESTNG_CONFIGURATION_FAILED",
            "failed",
          );
          const before = await fixture.batches.get("batch");
          const all = await fixture.batches.readExceptionRecords({ batchId: "batch", limit: 51 });
          const terminal = await fixture.batches.readExceptionRecords({
            batchId: "batch",
            scope: "terminal",
            limit: 51,
          });
          expect(all.items).toHaveLength(codes.length + 1);
          expect(terminal.items).toHaveLength(codes.length);
          expect(
            terminal.items.every((item) => item.kind === "attempt" && item.affectsBatchStatus),
          ).toBe(true);
          expect(all.items.find((item) => item.runId === "recovered-failure")).toMatchObject({
            affectsBatchStatus: false,
          });
          expect(await fixture.batches.get("batch")).toEqual(before);
        } finally {
          await fixture.close();
        }
      });
      it("uses an explicit unknown reason for legacy missing codes and bounds long descriptions", async () => {
        const fixture = await createFixture(dialect);
        try {
          for (const [index, code] of [null, "", "   "].entries()) {
            const id = `legacy-${index}`;
            await addRun(fixture, id, code);
            await addAttempt(
              fixture,
              id,
              1,
              code,
              "failed",
              index === 0 ? "说明🙂".repeat(3000) : "",
            );
          }
          await addRun(fixture, "legacy-unstarted", " ");
          const records = await fixture.batches.readExceptionRecords({
            batchId: "batch",
            limit: 51,
          });
          expect(records.items).toHaveLength(4);
          expect(records.items.every((item) => item.resultCode === "UNKNOWN_RESULT")).toBe(true);
          expect(
            records.items.every(
              (item) => item.summary.trim().length > 0 && item.summary.length <= 8192,
            ),
          ).toBe(true);
          expect(records.completions).toMatchObject([
            { status: "failed", abnormal: true, count: 4 },
          ]);
        } finally {
          await fixture.close();
        }
      });
      it("locates an unstarted timeout in the later round and filters before cursor paging", async () => {
        const fixture = await createFixture(dialect);
        try {
          await addRun(fixture, "later-queue", "QUEUE_TIMEOUT", "failed", 2);
          await addAttempt(fixture, "later-queue", 1, "TESTNG_ASSERTIONS_FAILED", "failed");
          await addRun(fixture, "recovered", "TESTNG_SUCCEEDED", "succeeded");
          await addAttempt(fixture, "recovered", 1, "LEASE_EXPIRED", "timed_out");
          await addAttempt(fixture, "recovered", 2, "TESTNG_SUCCEEDED", "succeeded");
          const first = await fixture.batches.readExceptionRecords({
            batchId: "batch",
            scope: "terminal",
            limit: 1,
          });
          expect(first.items).toMatchObject([
            { kind: "run", round: 2, resultCode: "QUEUE_TIMEOUT", attemptNumber: null },
          ]);
          const last = first.items[0]!;
          expect(
            (
              await fixture.batches.readExceptionRecords({
                batchId: "batch",
                scope: "terminal",
                limit: 2,
                after: { occurredAt: last.occurredAt, id: last.id },
              })
            ).items,
          ).toEqual([]);
          const page = await fixture.batches.listCasePage({
            batchId: "batch",
            scope: 2,
            sort: "none",
            direction: "asc",
            offset: 0,
            limit: 50,
          });
          expect(page!.items).toMatchObject([
            { round: 2, run: { terminalReasonCode: "QUEUE_TIMEOUT" } },
          ]);
          expect(page!.items[0]!.attempt).toBeUndefined();
        } finally {
          await fixture.close();
        }
      });
    },
  );
}
