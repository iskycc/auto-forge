import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type {
  CaseActivity,
  CaseExecutionHistoryPage,
  CaseExecutionHistoryQuery,
  ExecutionControlRepository,
  LatestCaseRunOutcome,
  RunBatchRepository,
} from "@autoforge/application";
import {
  createPostgresDatabase,
  createSqliteDatabase,
  PostgresCaseCatalogRepository,
  PostgresRunBatchRepository,
  SqliteCaseCatalogRepository,
  SqliteRunBatchRepository,
  type PostgresDatabaseHandle,
  type SqliteDatabaseHandle,
} from "@autoforge/db";
import { PostgresExecutionControlRepository } from "@autoforge/db/postgres";
import { createAttemptLogStore, SqliteExecutionControlRepository } from "@autoforge/db/sqlite";
import { describe, expect, it } from "vitest";

// 即时补槽回归契约：running 批次必须继续参与调度（空闲并发槽立即领取下一个用例），
// 且完成上报要回传 batchId/batchClosed 供路由层触发补调度与 Agent 清理批次目录。
// SQLite 使用真实临时库；PostgreSQL 仅在提供 AUTOFORGE_TEST_POSTGRES_URL 时运行。
type RefillHarness = {
  batches: RunBatchRepository;
  executions: ExecutionControlRepository;
  listCaseActivity(caseDefinitionId: string, limit: number): Promise<CaseActivity>;
  listCaseExecutionHistory(
    caseDefinitionId: string,
    query: CaseExecutionHistoryQuery,
  ): Promise<CaseExecutionHistoryPage>;
  listLatestRunOutcomes(caseDefinitionIds: readonly string[]): Promise<LatestCaseRunOutcome[]>;
  projectId: string;
  runnerId: string;
  batchRunningId: string;
  batchQueuedId: string;
  batchSucceededId: string;
  completion: CompletionFixture;
  rawQuery(sql: string, parameters?: unknown[]): Promise<void>;
  dispose(): Promise<void>;
};

type CompletionFixture = {
  batchId: string;
  attempt1Id: string;
  attempt2Id: string;
  lease1TokenHash: string;
  lease2TokenHash: string;
  lateBatchId: string;
  lateAttemptId: string;
  lateLeaseTokenHash: string;
};

const temporaryDirectories: string[] = [];

async function cleanupTemporaryDirectories(): Promise<void> {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

async function createSqliteHarness(): Promise<RefillHarness> {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-scheduling-refill-"));
  temporaryDirectories.push(directory);
  const handle: SqliteDatabaseHandle = createSqliteDatabase({
    databasePath: resolve(directory, "autoforge.sqlite"),
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
  });
  const fixture = await seedFixture((sql, parameters) =>
    Promise.resolve(handle.client.prepare(sql).run(...(parameters ?? []))),
  );
  return {
    batches: new SqliteRunBatchRepository(handle),
    executions: new SqliteExecutionControlRepository(
      handle,
      createAttemptLogStore(resolve(directory, "attempt-logs")),
    ),
    listCaseActivity: (caseDefinitionId, limit) =>
      new SqliteCaseCatalogRepository(handle).listCaseActivity(caseDefinitionId, limit),
    listCaseExecutionHistory: (caseDefinitionId, query) =>
      new SqliteCaseCatalogRepository(handle).listCaseExecutionHistory(caseDefinitionId, query),
    listLatestRunOutcomes: (caseDefinitionIds) =>
      new SqliteCaseCatalogRepository(handle).listLatestRunOutcomes(caseDefinitionIds),
    ...fixture,
    rawQuery: async (sql, parameters) => {
      handle.client.prepare(sql).run(...(parameters ?? []));
    },
    async dispose() {
      handle.close();
    },
  };
}

async function insertQueuedRun(harness: RefillHarness, batchId: string): Promise<string> {
  const runId = randomUUID();
  await harness.rawQuery(
    `INSERT INTO execution_runs
       (id, batch_id, case_definition_id, case_version, display_name, class_name, status,
        attempt_count, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'Queued refill', 'com.example.QueuedRefill', 'queued', 0, ?, ?)`,
    [runId, batchId, `case-${runId}`, "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z"],
  );
  return runId;
}

function schedulingRefillCases(createHarness: () => Promise<RefillHarness>): void {
  it("persists each round concurrency and records a dynamic transition event atomically", async () => {
    const harness = await createHarness();
    try {
      await expect(
        harness.batches.recordRoundConcurrency({
          batchId: harness.batchQueuedId,
          round: 2,
          concurrency: 80,
          source: "base",
          recordedAt: "2026-08-10T00:00:30.000Z",
        }),
      ).resolves.toBe("created");
      await expect(
        harness.batches.recordRoundConcurrency({
          batchId: harness.batchQueuedId,
          round: 2,
          concurrency: 40,
          source: "rule_transition",
          ruleId: "high-pass",
          previousConcurrency: 80,
          transitionEvent: {
            id: randomUUID(),
            message: "第 2 轮动态并发由 80 调整为 40",
            payload: { executionRound: 2, previousConcurrency: 80, concurrency: 40 },
          },
          recordedAt: "2026-08-10T00:00:31.000Z",
        }),
      ).resolves.toBe("existing");
      await expect(
        harness.batches.recordRoundConcurrency({
          batchId: harness.batchQueuedId,
          round: 2,
          concurrency: 40,
          source: "rule_transition",
          ruleId: "high-pass",
          previousConcurrency: 80,
          transitionEvent: {
            id: randomUUID(),
            message: "重复调度快照不得重复记录事件",
            payload: { executionRound: 2, previousConcurrency: 80, concurrency: 40 },
          },
          recordedAt: "2026-08-10T00:00:32.000Z",
        }),
      ).resolves.toBe("existing");

      const details = await harness.batches.get(harness.batchQueuedId);
      expect(details?.roundConcurrencies).toContainEqual({
        round: 2,
        concurrency: 40,
        source: "rule_transition",
        ruleId: "high-pass",
        previousConcurrency: 80,
        recordedAt: "2026-08-10T00:00:31.000Z",
      });
      const events = await harness.batches.listSchedulingEvents({
        batchId: harness.batchQueuedId,
        limit: 20,
      });
      expect(
        events.items.filter((event) => event.eventType === "retry_concurrency_changed"),
      ).toEqual([
        expect.objectContaining({
          payload: { executionRound: 2, previousConcurrency: 80, concurrency: 40 },
        }),
      ]);
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("hides diagnostic case reruns from execution history while preserving direct log lookup", async () => {
    const harness = await createHarness();
    const caseDefinitionId = `case-diagnostic-${randomUUID()}`;
    const visibleRunIds = [randomUUID(), randomUUID(), randomUUID()];
    const diagnosticRunId = randomUUID();
    const firstAttemptId = randomUUID();
    const secondAttemptId = randomUUID();
    try {
      await harness.rawQuery(
        `UPDATE run_batches
         SET batch_kind = 'case_log_rerun', parent_batch_id = ?,
             source_execution_run_id = ?, requested_by_username = 'c12345678',
             requested_by_source = 'ldap'
         WHERE id = ?`,
        [harness.batchRunningId, harness.completion.attempt1Id, harness.batchQueuedId],
      );
      await harness.rawQuery(
        `INSERT INTO execution_runs
           (id, batch_id, case_definition_id, case_version, display_name, class_name,
            status, attempt_count, terminal_outcome, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'Visible run 1', 'example.VisibleTest', 'succeeded', 0,
                 'succeeded', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'),
                (?, ?, ?, 1, 'Visible run 2', 'example.VisibleTest', 'failed', 0,
                 'failed', '2026-08-10T00:01:00.000Z', '2026-08-10T00:01:00.000Z'),
                (?, ?, ?, 1, 'Visible run 3', 'example.VisibleTest', 'succeeded', 2,
                 'succeeded', '2026-08-10T00:02:00.000Z', '2026-08-10T00:02:00.000Z'),
                (?, ?, ?, 1, 'Diagnostic run', 'example.VisibleTest', 'failed', 0,
                 'failed', '2026-08-10T00:03:00.000Z', '2026-08-10T00:03:00.000Z')`,
        [
          visibleRunIds[0],
          harness.batchSucceededId,
          caseDefinitionId,
          visibleRunIds[1],
          harness.batchRunningId,
          caseDefinitionId,
          visibleRunIds[2],
          harness.completion.batchId,
          caseDefinitionId,
          diagnosticRunId,
          harness.batchQueuedId,
          caseDefinitionId,
        ],
      );
      await harness.rawQuery(
        `INSERT INTO run_attempts
           (id, execution_run_id, runner_id, attempt_number, status, scheduling_score,
            result_code, duration_ms, created_at, finished_at)
         VALUES (?, ?, ?, 1, 'failed', 0.8, 'TEST_ASSERTION_FAILED', 200,
                 '2026-08-10T00:02:10.000Z', '2026-08-10T00:02:11.000Z'),
                (?, ?, ?, 2, 'succeeded', 0.9, 'TESTNG_SUCCEEDED', 120,
                 '2026-08-10T00:02:20.000Z', '2026-08-10T00:02:21.000Z')`,
        [
          firstAttemptId,
          visibleRunIds[2],
          harness.runnerId,
          secondAttemptId,
          visibleRunIds[2],
          harness.runnerId,
        ],
      );

      await expect(harness.batches.list(100)).resolves.not.toContainEqual(
        expect.objectContaining({ id: harness.batchQueuedId }),
      );
      await expect(harness.batches.get(harness.batchQueuedId)).resolves.toMatchObject({
        id: harness.batchQueuedId,
        kind: "case_log_rerun",
        requestedBy: { username: "c12345678", source: "ldap" },
      });
      await expect(harness.listCaseActivity(caseDefinitionId, 20)).resolves.toMatchObject({
        executions: [...visibleRunIds].reverse().map((runId) => ({ runId })),
      });
      const firstPage = await harness.listCaseExecutionHistory(caseDefinitionId, {
        limit: 2,
        includeRunnerNames: true,
      });
      expect(firstPage.items.map((item) => item.runId)).toEqual([
        visibleRunIds[2],
        visibleRunIds[1],
      ]);
      expect(firstPage.items[0]?.attempts).toEqual([
        expect.objectContaining({
          id: firstAttemptId,
          attemptNumber: 1,
          runnerName: "runner-refill",
          resultCode: "TEST_ASSERTION_FAILED",
        }),
        expect.objectContaining({
          id: secondAttemptId,
          attemptNumber: 2,
          resultCode: "TESTNG_SUCCEEDED",
        }),
      ]);
      expect(firstPage.nextCursor).toBeTruthy();
      const finalPage = await harness.listCaseExecutionHistory(caseDefinitionId, {
        cursor: firstPage.nextCursor!,
        limit: 2,
      });
      expect(finalPage.items).toMatchObject([{ runId: visibleRunIds[0] }]);
      expect(finalPage.nextCursor).toBeUndefined();
      await expect(
        harness.listCaseExecutionHistory(caseDefinitionId, { cursor: "invalid", limit: 2 }),
      ).rejects.toMatchObject({ code: "CASE_EXECUTION_CURSOR_INVALID" });
      await expect(harness.listLatestRunOutcomes([caseDefinitionId])).resolves.toMatchObject([
        { caseDefinitionId, outcome: "succeeded" },
      ]);
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("carries Runner and actual Adapter IP history across public-log diagnostic batches", async () => {
    const harness = await createHarness();
    const secondRunnerId = randomUUID();
    const sourceRunId = randomUUID();
    const previousDiagnosticRunId = randomUUID();
    const currentDiagnosticRunId = randomUUID();
    const sourceAttemptId = randomUUID();
    const previousDiagnosticAttemptId = randomUUID();
    const now = "2026-08-10T00:05:00.000Z";
    const runtime = (runId: string, initialAddress: string) =>
      JSON.stringify({
        suiteName: "adapter-suite",
        testName: "adapter-test",
        environmentAddresses: ["10.0.0.11", "10.0.0.12", "10.0.0.13"],
        environmentAddressByRunId: { [runId]: initialAddress },
        fallbackEnvironmentAddress: "",
      });
    try {
      await harness.rawQuery(
        `INSERT INTO runners
           (id, credential_hash, name, os, architecture, agent_version, protocol_version,
            labels_json, capabilities_json, max_concurrency, busy_slots, last_seen_at, created_at,
            updated_at)
         VALUES (?, ?, 'runner-refill-2', 'linux', 'amd64', '0.2.2', 1, '[]',
                 '["executor:testng-v1","isolation:cgroup-v2","java:21.0.8","testng:7.11.0"]',
                 2, 0, ?, ?, ?)`,
        [secondRunnerId, `hash-${secondRunnerId}`, now, now, now],
      );
      await harness.rawQuery(
        `UPDATE run_batches SET total_runs = 1, adapter_runtime_json = ? WHERE id = ?`,
        [runtime(sourceRunId, "10.0.0.11"), harness.batchSucceededId],
      );
      await harness.rawQuery(
        `UPDATE run_batches
         SET batch_kind = 'case_log_rerun', parent_batch_id = ?, source_execution_run_id = ?,
             total_runs = 1, adapter_runtime_json = ?, created_at = '2026-08-10T00:04:00.000Z'
         WHERE id = ?`,
        [
          harness.batchSucceededId,
          sourceRunId,
          runtime(previousDiagnosticRunId, "10.0.0.12"),
          harness.batchRunningId,
        ],
      );
      await harness.rawQuery(
        `UPDATE run_batches
         SET batch_kind = 'case_log_rerun', parent_batch_id = ?, source_execution_run_id = ?,
             total_runs = 1, adapter_runtime_json = ?, created_at = '2026-08-10T00:03:00.000Z'
         WHERE id = ?`,
        [
          harness.batchSucceededId,
          sourceRunId,
          runtime(currentDiagnosticRunId, "10.0.0.13"),
          harness.batchQueuedId,
        ],
      );
      for (const [runId, batchId, status, createdAt] of [
        [sourceRunId, harness.batchSucceededId, "succeeded", "2026-08-10T00:01:00.000Z"],
        [previousDiagnosticRunId, harness.batchRunningId, "succeeded", "2026-08-10T00:02:00.000Z"],
        [currentDiagnosticRunId, harness.batchQueuedId, "queued", "2026-08-10T00:03:00.000Z"],
      ]) {
        await harness.rawQuery(
          `INSERT INTO execution_runs
             (id, batch_id, case_definition_id, case_version, display_name, class_name, status,
              attempt_count, terminal_outcome, created_at, updated_at)
           VALUES (?, ?, 'case-diagnostic-rotation', 1, 'Diagnostic rotation',
                   'example.DiagnosticRotationTest', ?, ?, ?, ?, ?)`,
          [
            runId,
            batchId,
            status,
            status === "queued" ? 0 : 1,
            status === "queued" ? null : "succeeded",
            createdAt,
            createdAt,
          ],
        );
      }
      await harness.rawQuery(
        `INSERT INTO run_attempts
           (id, execution_run_id, runner_id, attempt_number, status, outcome,
            scheduling_score, created_at)
         VALUES (?, ?, ?, 1, 'succeeded', 'succeeded', 0.8, '2026-08-10T00:01:10.000Z'),
                (?, ?, ?, 1, 'succeeded', 'succeeded', 0.8, '2026-08-10T00:02:10.000Z')`,
        [
          sourceAttemptId,
          sourceRunId,
          harness.runnerId,
          previousDiagnosticAttemptId,
          previousDiagnosticRunId,
          secondRunnerId,
        ],
      );
      await harness.rawQuery(
        `INSERT INTO assignments
           (id, attempt_id, execution_run_id, batch_id, runner_id, status, priority,
            execution_spec_json, available_at, claim_deadline_at, claimed_at, version,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'completed', 0, ?, ?, ?, ?, 1, ?, ?)`,
        [
          randomUUID(),
          previousDiagnosticAttemptId,
          previousDiagnosticRunId,
          harness.batchRunningId,
          secondRunnerId,
          JSON.stringify({ adapter: { environmentAddress: "10.0.0.12" } }),
          now,
          now,
          now,
          "2026-08-10T00:02:10.000Z",
          "2026-08-10T00:02:11.000Z",
        ],
      );
      await harness.rawQuery("INSERT INTO run_batch_runners (batch_id, runner_id) VALUES (?, ?)", [
        harness.batchQueuedId,
        harness.runnerId,
      ]);
      await harness.rawQuery("INSERT INTO run_batch_runners (batch_id, runner_id) VALUES (?, ?)", [
        harness.batchQueuedId,
        secondRunnerId,
      ]);

      await expect(
        harness.batches.getRerunSnapshot(harness.batchSucceededId, {
          executionRunId: sourceRunId,
        }),
      ).resolves.toMatchObject({
        caseLogRerunRotation: { previousAdapterEnvironmentAddress: "10.0.0.12" },
      });
      const scheduling = await harness.batches.getSchedulingSnapshot(
        harness.batchQueuedId,
        "2026-08-09T00:00:00.000Z",
      );
      expect(scheduling?.runnerHistoryByRun).toEqual({
        [currentDiagnosticRunId]: [secondRunnerId],
      });
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("persists an activated retry concurrency until a later ordered rule takes over", async () => {
    const harness = await createHarness();
    const firstState = {
      ruleId: "high-pass",
      ruleIndex: 0,
      concurrency: 40,
      activatedRound: 2,
    };
    const laterState = {
      ruleId: "small-remainder",
      ruleIndex: 1,
      concurrency: 10,
      activatedRound: 4,
    };
    const policy = {
      executor: "testng",
      concurrency: 100,
      runnerLabels: [],
      artifactPatterns: [],
      retryConcurrencyRules: [
        {
          id: "high-pass",
          executionRound: 2,
          previousRoundPassRateMinimum: 70,
          concurrency: 40,
        },
        {
          id: "small-remainder",
          executionRound: 4,
          remainingRunsMaximum: 20,
          concurrency: 10,
        },
      ],
    };
    try {
      await harness.rawQuery(
        "UPDATE run_batches SET retry_mode = 'round', current_round = 2, policy_json = ? WHERE id = ?",
        [JSON.stringify(policy), harness.batchQueuedId],
      );
      await expect(
        harness.batches.activateRetryConcurrency({
          batchId: harness.batchQueuedId,
          executionRound: 2,
          expectedRuleId: null,
          state: firstState,
          updatedAt: "2026-08-10T00:01:00.000Z",
        }),
      ).resolves.toEqual(firstState);
      // 同一轮最多激活一个阶段，避免两条同时满足时连续跳级。
      await expect(
        harness.batches.activateRetryConcurrency({
          batchId: harness.batchQueuedId,
          executionRound: 2,
          expectedRuleId: "high-pass",
          state: { ...laterState, activatedRound: 2 },
          updatedAt: "2026-08-10T00:01:01.000Z",
        }),
      ).resolves.toEqual(firstState);

      await harness.rawQuery("UPDATE run_batches SET current_round = 4 WHERE id = ?", [
        harness.batchQueuedId,
      ]);
      await expect(
        harness.batches.activateRetryConcurrency({
          batchId: harness.batchQueuedId,
          executionRound: 4,
          expectedRuleId: "high-pass",
          state: laterState,
          updatedAt: "2026-08-10T00:02:00.000Z",
        }),
      ).resolves.toEqual(laterState);
      await expect(
        harness.batches.getSchedulingSnapshot(harness.batchQueuedId, "2026-08-10T00:00:00.000Z"),
      ).resolves.toMatchObject({ retryConcurrencyState: laterState });
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("keeps delayed batches out of every schedulable view until their planned start", async () => {
    const harness = await createHarness();
    try {
      await insertQueuedRun(harness, harness.batchQueuedId);
      await harness.rawQuery("UPDATE run_batches SET scheduled_for = ? WHERE id = ?", [
        "2026-08-10T00:15:00.000Z",
        harness.batchQueuedId,
      ]);
      await expect(
        harness.batches.listSchedulableBatchIds(10, "2026-08-10T00:14:59.000Z"),
      ).resolves.not.toContain(harness.batchQueuedId);
      await expect(
        harness.batches.listSchedulableBatchIds(10, "2026-08-10T00:15:00.000Z"),
      ).resolves.toContain(harness.batchQueuedId);
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("counts any passed round as passed and only the selected final failure as failed", async () => {
    const harness = await createHarness();
    const batchId = randomUUID();
    const passedRunId = randomUUID();
    const failedRunId = randomUUID();
    const at = "2026-08-10T00:04:00.000Z";
    try {
      await harness.rawQuery(
        `INSERT INTO run_batches
           (id, suite_id, suite_name, suite_version, status, retry_limit, retry_mode,
            environment_json, total_runs, project_id, scheduled_for, created_at, updated_at)
         VALUES (?, 'suite-final-counts', 'Final count suite', 1, 'failed', 1, 'round',
                 '[]', 2, ?, ?, ?, ?)`,
        [batchId, harness.projectId, at, at, at],
      );
      for (const [runId, displayName] of [
        [passedRunId, "Passed once"],
        [failedRunId, "Failed finally"],
      ]) {
        await harness.rawQuery(
          `INSERT INTO execution_runs
             (id, batch_id, case_definition_id, case_version, display_name, class_name,
              status, attempt_count, terminal_outcome, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, 'example.FinalCountTest', 'failed', 2, 'failed', ?, ?)`,
          [runId, batchId, `case-${runId}`, displayName, at, at],
        );
      }
      for (const [runId, firstOutcome, secondOutcome] of [
        [passedRunId, "succeeded", "failed"],
        [failedRunId, "failed", "failed"],
      ]) {
        await harness.rawQuery(
          `INSERT INTO run_attempts
             (id, execution_run_id, runner_id, attempt_number, status, outcome,
              scheduling_score, created_at)
           VALUES (?, ?, ?, 1, ?, ?, 1, ?), (?, ?, ?, 2, ?, ?, 1, ?)`,
          [
            randomUUID(),
            runId,
            harness.runnerId,
            firstOutcome,
            firstOutcome,
            at,
            randomUUID(),
            runId,
            harness.runnerId,
            secondOutcome,
            secondOutcome,
            at,
          ],
        );
      }

      await expect(harness.batches.getSummary(batchId)).resolves.toMatchObject({
        totalRuns: 2,
        succeededRuns: 1,
        failedRuns: 1,
        timedOutRuns: 0,
      });
      await expect(
        harness.batches.getRerunSnapshot(batchId, { finalFailuresOnly: true }),
      ).resolves.toMatchObject({
        runs: [{ id: failedRunId, displayName: "Failed finally" }],
      });
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("lists running batches as schedulable alongside queued ones", async () => {
    const harness = await createHarness();
    try {
      await insertQueuedRun(harness, harness.batchRunningId);
      await insertQueuedRun(harness, harness.batchQueuedId);
      const ids = await harness.batches.listSchedulableBatchIds(10, "2026-08-10T00:10:00.000Z");
      expect(ids).toContain(harness.batchRunningId);
      expect(ids).toContain(harness.batchQueuedId);
      expect(ids).not.toContain(harness.batchSucceededId);
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("lists running batches as schedulable for a selected runner", async () => {
    const harness = await createHarness();
    try {
      await insertQueuedRun(harness, harness.batchRunningId);
      const ids = await harness.batches.listSchedulableBatchIdsForRunner(
        harness.runnerId,
        10,
        "2026-08-10T00:10:00.000Z",
      );
      expect(ids).toContain(harness.batchRunningId);
      expect(ids).not.toContain(harness.batchSucceededId);
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("does not let an active batch without queued work consume a Runner scan limit", async () => {
    const harness = await createHarness();
    try {
      await insertQueuedRun(harness, harness.batchQueuedId);
      await harness.rawQuery("INSERT INTO run_batch_runners (batch_id, runner_id) VALUES (?, ?)", [
        harness.batchQueuedId,
        harness.runnerId,
      ]);
      await harness.rawQuery("UPDATE run_batches SET priority = 100 WHERE id = ?", [
        harness.batchRunningId,
      ]);

      await expect(
        harness.batches.listSchedulableBatchIdsForRunner(
          harness.runnerId,
          1,
          "2026-08-10T00:10:00.000Z",
        ),
      ).resolves.toEqual([harness.batchQueuedId]);
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("counts every non-terminal batch phase in project and runner capacity", async () => {
    const harness = await createHarness();
    try {
      for (const status of ["scheduled", "dispatching", "running"] as const) {
        await harness.rawQuery("UPDATE run_batches SET status = ? WHERE id = ?", [
          status,
          harness.batchRunningId,
        ]);
        const snapshot = await harness.batches.getSchedulingSnapshot(
          harness.batchRunningId,
          "2026-08-10T00:00:00.000Z",
        );
        expect(snapshot?.projectActiveRuns).toBe(2);
        expect(snapshot?.candidates).toEqual([
          expect.objectContaining({
            runner: expect.objectContaining({ id: harness.runnerId }),
            reservedSlots: 2,
          }),
        ]);
      }
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("reports only non-terminal cached batches selected for the runner as reusable", async () => {
    const harness = await createHarness();
    try {
      await expect(
        harness.batches.listReusableBatchIdsForRunner(harness.runnerId, [
          harness.batchRunningId,
          harness.batchSucceededId,
        ]),
      ).resolves.toEqual([harness.batchRunningId]);
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("reports batchClosed per completion without treating only-in-flight work as refillable", async () => {
    const harness = await createHarness();
    const { completion } = harness;
    try {
      const first = await harness.executions.completeAttempt({
        runnerId: harness.runnerId,
        attemptId: completion.attempt1Id,
        completionId: randomUUID(),
        leaseTokenHash: completion.lease1TokenHash,
        resultDigest: randomUUID(),
        result: {
          status: "succeeded",
          resultCode: "OK",
          summary: "通过。",
          durationMs: 10,
          artifacts: [],
        },
        eventId: randomUUID(),
        acceptedAt: "2026-08-10T00:05:00.000Z",
      });
      expect(first.disposition).toBe("accepted");
      expect(first.batchId).toBe(completion.batchId);
      expect(first.batchClosed).toBe(false);
      // 另一个 run 已经在途，没有 queued run 时不应占用 Runner 的有限批次扫描窗口。
      expect(
        await harness.batches.listSchedulableBatchIds(10, "2026-08-10T00:06:00.000Z"),
      ).not.toContain(completion.batchId);

      const last = await harness.executions.completeAttempt({
        runnerId: harness.runnerId,
        attemptId: completion.attempt2Id,
        completionId: randomUUID(),
        leaseTokenHash: completion.lease2TokenHash,
        resultDigest: randomUUID(),
        result: {
          status: "succeeded",
          resultCode: "OK",
          summary: "通过。",
          durationMs: 12,
          artifacts: [],
        },
        eventId: randomUUID(),
        acceptedAt: "2026-08-10T00:07:00.000Z",
      });
      expect(last.disposition).toBe("accepted");
      expect(last.batchId).toBe(completion.batchId);
      expect(last.batchClosed).toBe(true);
      expect(
        await harness.batches.listSchedulableBatchIds(10, "2026-08-10T00:08:00.000Z"),
      ).not.toContain(completion.batchId);
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("reschedules a Runner infrastructure failure even when the case retry limit is zero", async () => {
    const harness = await createHarness();
    const { completion } = harness;
    try {
      await harness.rawQuery("UPDATE run_batches SET retry_mode = 'round' WHERE id = ?", [
        completion.batchId,
      ]);
      const failed = await harness.executions.completeAttempt({
        runnerId: harness.runnerId,
        attemptId: completion.attempt1Id,
        completionId: randomUUID(),
        leaseTokenHash: completion.lease1TokenHash,
        resultDigest: randomUUID(),
        result: {
          status: "failed",
          resultCode: "PROCESS_START_FAILED",
          summary: "Runner could not start the process.",
          durationMs: 1,
          artifacts: [],
        },
        eventId: randomUUID(),
        acceptedAt: "2026-08-10T00:05:00.000Z",
      });

      expect(failed).toMatchObject({
        disposition: "accepted",
        retryScheduled: true,
        batchClosed: false,
      });
      const snapshot = await harness.batches.getSchedulingSnapshot(
        completion.batchId,
        "2026-08-10T00:00:00.000Z",
      );
      expect(Object.values(snapshot?.runnerFailureIdsByRun ?? {})).toContainEqual([
        harness.runnerId,
      ]);
      // 基础设施异常不等待整个用例轮次结束，应立即进入重调度。
      expect(snapshot?.queuedRuns).toHaveLength(1);
      expect(snapshot?.queuedRuns[0]).not.toHaveProperty("heldRound");
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("reports batchClosed on late completions from the stored batch status", async () => {
    const harness = await createHarness();
    const { completion } = harness;
    try {
      const late = await harness.executions.completeAttempt({
        runnerId: harness.runnerId,
        attemptId: completion.lateAttemptId,
        completionId: randomUUID(),
        leaseTokenHash: completion.lateLeaseTokenHash,
        resultDigest: randomUUID(),
        result: {
          status: "succeeded",
          resultCode: "OK",
          summary: "迟到结果。",
          durationMs: 5,
          artifacts: [],
        },
        eventId: randomUUID(),
        acceptedAt: "2026-08-10T02:00:00.000Z",
      });
      expect(late.disposition).toBe("late");
      expect(late.batchId).toBe(completion.lateBatchId);
      expect(late.batchClosed).toBe(true);
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("ignores expired active records that belong to a terminal batch", async () => {
    const harness = await createHarness();
    try {
      await harness.rawQuery(
        "UPDATE assignment_leases SET expires_at = ? WHERE assignment_id = (SELECT id FROM assignments WHERE attempt_id = ?)",
        ["2000-01-01T00:00:00.000Z", harness.completion.lateAttemptId],
      );
      await expect(
        harness.executions.recoverExpired({
          now: "2000-01-01T00:00:00.001Z",
          eventIds: [randomUUID()],
          limit: 10,
        }),
      ).resolves.toEqual([]);
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("ignores unclaimed records that belong to a terminal batch", async () => {
    const harness = await createHarness();
    try {
      await harness.rawQuery(
        "UPDATE assignments SET status = 'pending', claim_deadline_at = ? WHERE attempt_id = ?",
        ["2000-01-01T00:00:00.000Z", harness.completion.lateAttemptId],
      );
      await harness.rawQuery(
        "UPDATE assignment_leases SET status = 'released' WHERE assignment_id = (SELECT id FROM assignments WHERE attempt_id = ?)",
        [harness.completion.lateAttemptId],
      );
      await harness.rawQuery("UPDATE run_attempts SET status = 'assigned' WHERE id = ?", [
        harness.completion.lateAttemptId,
      ]);
      await harness.rawQuery(
        "UPDATE execution_runs SET status = 'assigned' WHERE id = (SELECT execution_run_id FROM run_attempts WHERE id = ?)",
        [harness.completion.lateAttemptId],
      );
      await expect(
        harness.executions.recoverExpired({
          now: "2000-01-01T00:00:00.001Z",
          eventIds: [randomUUID()],
          limit: 10,
        }),
      ).resolves.toEqual([]);
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });
}

type FixtureIds = {
  projectId: string;
  runnerId: string;
  batchRunningId: string;
  batchQueuedId: string;
  batchSucceededId: string;
  completion: CompletionFixture;
};

// fixture 需要真实的父行满足外键；SQL 统一用 ? 占位符书写，PG 侧转为 $N。
async function seedFixture(
  execute: (sql: string, parameters?: unknown[]) => Promise<unknown>,
): Promise<FixtureIds> {
  const ids: FixtureIds = {
    projectId: randomUUID(),
    runnerId: randomUUID(),
    batchRunningId: randomUUID(),
    batchQueuedId: randomUUID(),
    batchSucceededId: randomUUID(),
    completion: {
      batchId: randomUUID(),
      attempt1Id: randomUUID(),
      attempt2Id: randomUUID(),
      lease1TokenHash: `lease-hash-${randomUUID()}`,
      lease2TokenHash: `lease-hash-${randomUUID()}`,
      lateBatchId: randomUUID(),
      lateAttemptId: randomUUID(),
      lateLeaseTokenHash: `lease-hash-${randomUUID()}`,
    },
  };
  const now = "2026-08-10T00:00:00.000Z";
  await execute(
    `INSERT INTO projects (id, name, slug, is_default, archived, created_at, updated_at)
     VALUES (?, 'Scheduling refill fixture', ?, FALSE, FALSE, ?, ?)`,
    [ids.projectId, `scheduling-refill-${ids.projectId}`, now, now],
  );
  await execute(
    `INSERT INTO runners
       (id, credential_hash, name, os, architecture, agent_version, protocol_version,
        labels_json, capabilities_json, max_concurrency, busy_slots, last_seen_at, created_at,
        updated_at)
     VALUES (?, ?, 'runner-refill', 'linux', 'amd64', '0.2.2', 1, '[]',
             '["executor:testng-v1","isolation:cgroup-v2","java:21.0.8","testng:7.11.0"]',
             2, 0, ?, ?, ?)`,
    [ids.runnerId, `hash-${ids.runnerId}`, now, now, now],
  );
  const insertBatch = async (batchId: string, status: string, totalRuns: number): Promise<void> => {
    await execute(
      `INSERT INTO run_batches
         (id, suite_id, suite_name, suite_version, status, retry_limit, environment_json,
          total_runs, project_id, created_at, updated_at)
       VALUES (?, 'suite-refill', 'Refill Suite', 1, ?, 0, '[]', ?, ?, ?, ?)`,
      [batchId, status, totalRuns, ids.projectId, now, now],
    );
  };
  await insertBatch(ids.batchRunningId, "running", 1);
  await insertBatch(ids.batchQueuedId, "queued", 1);
  await insertBatch(ids.batchSucceededId, "succeeded", 1);
  await execute("INSERT INTO run_batch_runners (batch_id, runner_id) VALUES (?, ?)", [
    ids.batchRunningId,
    ids.runnerId,
  ]);
  await execute("INSERT INTO run_batch_runners (batch_id, runner_id) VALUES (?, ?)", [
    ids.batchSucceededId,
    ids.runnerId,
  ]);

  const insertRun = async (
    runId: string,
    batchId: string,
    status: string,
    caseDefinitionId: string,
  ): Promise<void> => {
    await execute(
      `INSERT INTO execution_runs
         (id, batch_id, case_definition_id, case_version, display_name, class_name, status,
          attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'RefillTest', 'com.example.RefillTest', ?, 1, ?, ?)`,
      [runId, batchId, caseDefinitionId, status, now, now],
    );
  };
  const insertAttempt = async (attemptId: string, runId: string, status: string): Promise<void> => {
    await execute(
      `INSERT INTO run_attempts
         (id, execution_run_id, runner_id, attempt_number, status, scheduling_score, created_at)
       VALUES (?, ?, ?, 1, ?, 0.85, ?)`,
      [attemptId, runId, ids.runnerId, status, now],
    );
  };
  const insertAssignmentAndLease = async (
    attemptId: string,
    runId: string,
    batchId: string,
    tokenHash: string,
    leaseExpiresAt: string,
  ): Promise<void> => {
    const assignmentId = randomUUID();
    await execute(
      `INSERT INTO assignments
         (id, attempt_id, execution_run_id, batch_id, runner_id, status, priority,
          execution_spec_json, available_at, claim_deadline_at, claimed_at, version,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'running', 0, '{}', ?, ?, ?, 1, ?, ?)`,
      [assignmentId, attemptId, runId, batchId, ids.runnerId, now, now, now, now, now],
    );
    await execute(
      `INSERT INTO assignment_leases
         (id, assignment_id, runner_id, token_hash, token_encrypted, status, version,
          expires_at, renewed_at, created_at)
       VALUES (?, ?, ?, ?, 'encrypted', 'active', 1, ?, ?, ?)`,
      [randomUUID(), assignmentId, ids.runnerId, tokenHash, leaseExpiresAt, now, now],
    );
  };

  const { completion } = ids;
  await insertBatch(completion.batchId, "running", 2);
  const run1Id = randomUUID();
  const run2Id = randomUUID();
  await insertRun(run1Id, completion.batchId, "running", `case-refill-${run1Id}`);
  await insertRun(run2Id, completion.batchId, "running", `case-refill-${run2Id}`);
  await insertAttempt(completion.attempt1Id, run1Id, "running");
  await insertAttempt(completion.attempt2Id, run2Id, "running");
  await insertAssignmentAndLease(
    completion.attempt1Id,
    run1Id,
    completion.batchId,
    completion.lease1TokenHash,
    "2026-08-10T03:00:00.000Z",
  );
  await insertAssignmentAndLease(
    completion.attempt2Id,
    run2Id,
    completion.batchId,
    completion.lease2TokenHash,
    "2026-08-10T03:00:00.000Z",
  );

  // late 场景：批次已终态，租约已过期（acceptedAt 晚于 expires_at）。
  await insertBatch(completion.lateBatchId, "succeeded", 1);
  const lateRunId = randomUUID();
  await insertRun(lateRunId, completion.lateBatchId, "running", `case-refill-${lateRunId}`);
  await insertAttempt(completion.lateAttemptId, lateRunId, "running");
  await insertAssignmentAndLease(
    completion.lateAttemptId,
    lateRunId,
    completion.lateBatchId,
    completion.lateLeaseTokenHash,
    "2026-08-10T01:00:00.000Z",
  );
  return ids;
}

describe("SQLite scheduling refill contract", () => {
  schedulingRefillCases(createSqliteHarness);
});

const postgresConnectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;

describe.skipIf(!postgresConnectionString)("PostgreSQL scheduling refill contract", () => {
  schedulingRefillCases(async (): Promise<RefillHarness> => {
    const handle: PostgresDatabaseHandle = createPostgresDatabase({
      connectionString: postgresConnectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    await handle.ready;
    const fixture = await seedFixture((sql, parameters) =>
      handle.pool.query(toPostgresPlaceholders(sql), parameters ?? []).then(() => undefined),
    );
    const logsDirectory = await mkdtemp(resolve(tmpdir(), "autoforge-pg-refill-logs-"));
    temporaryDirectories.push(logsDirectory);
    const attemptLogs = createAttemptLogStore(logsDirectory);
    return {
      batches: new PostgresRunBatchRepository(handle),
      executions: new PostgresExecutionControlRepository(handle, attemptLogs),
      listCaseActivity: (caseDefinitionId, limit) =>
        new PostgresCaseCatalogRepository(handle).listCaseActivity(caseDefinitionId, limit),
      listCaseExecutionHistory: (caseDefinitionId, query) =>
        new PostgresCaseCatalogRepository(handle).listCaseExecutionHistory(caseDefinitionId, query),
      listLatestRunOutcomes: (caseDefinitionIds) =>
        new PostgresCaseCatalogRepository(handle).listLatestRunOutcomes(caseDefinitionIds),
      ...fixture,
      rawQuery: async (sql, parameters) => {
        await handle.pool.query(toPostgresPlaceholders(sql), parameters ?? []);
      },
      async dispose() {
        attemptLogs.close();
        try {
          await handle.pool.query("DELETE FROM run_batches WHERE project_id = $1", [
            fixture.projectId,
          ]);
          await handle.pool.query("DELETE FROM projects WHERE id = $1", [fixture.projectId]);
          await handle.pool.query("DELETE FROM runners WHERE id = $1", [fixture.runnerId]);
        } finally {
          await handle.close();
        }
      },
    };
  });
});

// fixture SQL 统一用 ? 书写；pg 驱动需要 $N，按每条语句独立编号替换。
function toPostgresPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}
