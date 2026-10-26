import { randomUUID } from "node:crypto";
import { insertCaseExecutionHistoryFixture } from "../../../tests/e2e/support/case-execution-history-fixture";
import { insertExecutionRecordsFixture } from "../../../tests/e2e/support/execution-records-fixture";
import { insertSuiteProgressFixture } from "../../../tests/e2e/support/suite-progress-fixture";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type {
  CaseSuiteRepository,
  CaseActivity,
  CaseExecutionHistoryPage,
  CaseExecutionHistoryQuery,
  ExecutionControlRepository,
  LatestCaseRunOutcome,
  RunBatchRepository,
  RunnerRepository,
} from "@autoforge/application";
import { RunBatchSchedulingService } from "@autoforge/application";
import { PlatformConfigurationStore } from "@autoforge/platform-config";
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
import { normalizeTestNgCompletion } from "../../application/src/normalize-testng-completion";

// 即时补槽回归契约：running 批次必须继续参与调度（空闲并发槽立即领取下一个用例），
// 且完成上报要回传 batchId/batchClosed 供路由层触发补调度与 Agent 清理批次目录。
// SQLite 使用真实临时库；PostgreSQL 仅在提供 AUTOFORGE_TEST_POSTGRES_URL 时运行。
type RefillHarness = {
  sqliteDataDirectory?: string;
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
    databasePath: resolve(directory, "db", "autoforge.sqlite"),
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
  });
  const fixture = await seedFixture((sql, parameters) =>
    Promise.resolve(handle.client.prepare(sql).run(...(parameters ?? []))),
  );
  return {
    sqliteDataDirectory: directory,
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

async function refillAndClaimWaitingTask(
  harness: RefillHarness,
  queuedRunId: string,
  caseType: "testng" | "ddt",
  now: string,
  runnerCapacity = { maxConcurrency: 46, busySlots: 45 },
): Promise<void> {
  const capabilities = [
    "executor:testng-v1",
    "isolation:cgroup-v2",
    "java:21.0.8",
    "testng:7.11.0",
    "adapter:cotest-testng-v1",
    "adapter:ddt-case-id-v1",
    "adapter:ddt-insight-url-v1",
  ];
  await harness.rawQuery(
    "UPDATE run_batches SET status='succeeded' WHERE project_id=? AND id NOT IN (?,?)",
    [harness.projectId, harness.batchRunningId, harness.batchQueuedId],
  );
  // One free Runner slot, shared by the two independent tasks; no JVMs are started.
  await harness.rawQuery(
    `UPDATE runners SET max_concurrency=?,busy_slots=?,capabilities_json=?,
      labels_json='["linux","java","testng"]',cpu_utilization_percent=30,
      memory_utilization_percent=70,load_average_1m=0,logical_cpu_count=16,
      metrics_observed_at=?,last_seen_at=? WHERE id=?`,
    [
      runnerCapacity.maxConcurrency,
      runnerCapacity.busySlots,
      JSON.stringify(capabilities),
      now,
      now,
      harness.runnerId,
    ],
  );
  const caseId = await prepareRefillExecutions(
    harness,
    harness.batchQueuedId,
    [queuedRunId],
    caseType,
    now,
  );
  const scheduling = refillSchedulingService(harness, now);
  expect(await scheduling.scheduleForRunner(harness.runnerId, 1, 1)).toBe(1);
  const claimed = await harness.executions.claim({
    runnerId: harness.runnerId,
    requestId: randomUUID(),
    availableSlots: 1,
    labels: ["linux", "java", "testng"],
    capabilities,
    now,
    leaseExpiresAt: new Date(Date.parse(now) + 45_000).toISOString(),
    leaseSeeds: [
      { id: randomUUID(), eventId: randomUUID(), tokenHash: "refill", tokenEncrypted: "refill" },
    ],
  });
  expect(claimed).toHaveLength(1);
  expect(claimed[0]?.assignment.executionSpec.batchId).toBe(harness.batchQueuedId);
  expect(claimed[0]?.assignment.executionSpec.executionRunId).toBe(queuedRunId);
  if (caseType === "ddt") expect(claimed[0]?.assignment.executionSpec.adapter?.caseId).toBe(caseId);
}

async function prepareRefillExecutions(
  harness: RefillHarness,
  batchId: string,
  queuedRunIds: readonly string[],
  caseType: "testng" | "ddt",
  now: string,
): Promise<string> {
  const sourceId = randomUUID();
  const classId = randomUUID();
  const caseId = "DDT-refill-中文";
  await harness.rawQuery(
    `INSERT INTO case_sources
      (id,project_id,display_name,original_file_name,object_key,sha256,size_bytes,
       class_count,method_count,status,warnings_json,inspection_json,created_at,updated_at)
      VALUES (?,?,'Refill','fixture.jar',?,?,100,1,1,'ready','[]','{}',?,?)`,
    [sourceId, harness.projectId, sourceId, sourceId.replaceAll("-", "").repeat(2), now, now],
  );
  await harness.rawQuery(
    `INSERT INTO case_definitions
      (id,project_id,source_id,class_name,package_name,display_name,enabled,
       groups_json,current_version,created_at,updated_at)
      VALUES (?,?,?,'example.SharedExecution','example','SharedExecution',TRUE,'[]',1,?,?)`,
    [classId, harness.projectId, sourceId, now, now],
  );
  await harness.rawQuery(
    "INSERT INTO case_versions(id,case_definition_id,source_id,version,snapshot_json,created_at) VALUES (?,?,?,1,'{}',?)",
    [randomUUID(), classId, sourceId, now],
  );
  for (const [index, queuedRunId] of queuedRunIds.entries()) {
    const executionClassId = caseType === "testng" && index > 0 ? randomUUID() : classId;
    const className =
      executionClassId === classId ? "example.SharedExecution" : `example.SharedExecution${index}`;
    if (executionClassId !== classId) {
      await harness.rawQuery(
        `INSERT INTO case_definitions
          (id,project_id,source_id,class_name,package_name,display_name,enabled,groups_json,current_version,created_at,updated_at)
          SELECT ?,project_id,source_id,?,package_name,?,enabled,groups_json,current_version,created_at,updated_at
          FROM case_definitions WHERE id=?`,
        [executionClassId, className, className, classId],
      );
      await harness.rawQuery(
        "INSERT INTO case_versions(id,case_definition_id,source_id,version,snapshot_json,created_at) VALUES (?,?,?,1,'{}',?)",
        [randomUUID(), executionClassId, sourceId, now],
      );
    }
    await harness.rawQuery(
      "UPDATE execution_runs SET case_type=?,case_definition_id=?,execution_case_definition_id=?,class_name=?,display_name=? WHERE id=?",
      [
        caseType,
        caseType === "ddt" ? randomUUID() : executionClassId,
        executionClassId,
        className,
        index === 0 ? caseId : `${caseId}-${index}`,
        queuedRunId,
      ],
    );
  }
  if (caseType === "ddt") {
    await harness.rawQuery("UPDATE run_batches SET adapter_runtime_json=? WHERE id=?", [
      JSON.stringify({
        suiteName: "DDT",
        testName: "DDT",
        environmentAddresses: [],
        environmentAddressByRunId: {},
        fallbackEnvironmentAddress: "",
      }),
      batchId,
    ]);
  }
  return caseId;
}

function refillSchedulingService(
  harness: RefillHarness,
  now: string,
  projectMaximumConcurrency = 128,
): RunBatchSchedulingService {
  return new RunBatchSchedulingService(
    harness.batches,
    {} as CaseSuiteRepository,
    {} as RunnerRepository,
    { now: () => new Date(now) },
    { next: () => randomUUID() },
    {
      maximumCpuUtilizationPercent: 80,
      maximumMemoryUtilizationPercent: 85,
      maximumLoadPerCpu: 1,
    },
    45,
    undefined,
    projectMaximumConcurrency,
  );
}

async function insertCaseHistoryRun(
  harness: RefillHarness,
  caseId: string,
  input: {
    status: "queued" | "assigned" | "running" | "succeeded" | "failed" | "cancelled";
    batchId?: string;
    batchStatus?: "running" | "succeeded" | "failed" | "cancelled";
    createdAt?: string;
    diagnostic?: boolean;
    attempts: Array<{
      status: "assigned" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";
      outcome?: "succeeded" | "failed" | "timed_out" | "cancelled";
      executionRound?: number;
      started?: boolean;
      finished?: boolean;
    }>;
  },
) {
  const batchId = input.batchId ?? randomUUID();
  const runId = randomUUID();
  const createdAt = input.createdAt ?? "2026-08-10T00:00:00.000Z";
  if (!input.batchId)
    await harness.rawQuery(
      `INSERT INTO run_batches
       (id, suite_id, suite_name, suite_version, project_id, status, retry_limit,
        environment_json, total_runs, batch_kind, created_at, updated_at)
     VALUES (?, 'history-suite', 'History task', 1, ?, ?, 0, '{}', 1, ?, ?, ?)`,
      [
        batchId,
        harness.projectId,
        input.batchStatus ?? "running",
        input.diagnostic ? "case_log_rerun" : "standard",
        createdAt,
        createdAt,
      ],
    );
  await harness.rawQuery(
    `INSERT INTO execution_runs
       (id, batch_id, case_definition_id, case_version, display_name, class_name,
        status, attempt_count, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'History case', 'example.HistoryCase', ?, ?, ?, ?)`,
    [runId, batchId, caseId, input.status, input.attempts.length, createdAt, createdAt],
  );
  const attemptIds: string[] = [];
  for (const [index, attempt] of input.attempts.entries()) {
    const attemptId = randomUUID();
    await harness.rawQuery(
      `INSERT INTO run_attempts
         (id, execution_run_id, runner_id, attempt_number, execution_round, status, outcome,
          scheduling_score, duration_ms, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 100, ?, ?, ?)`,
      [
        attemptId,
        runId,
        harness.runnerId,
        index + 1,
        attempt.executionRound ?? index + 1,
        attempt.status,
        attempt.outcome ?? null,
        createdAt,
        attempt.started === false ? null : createdAt,
        attempt.finished === false ? null : createdAt,
      ],
    );
    attemptIds.push(attemptId);
  }
  return { batchId, runId, attemptIds };
}

function schedulingRefillCases(createHarness: () => Promise<RefillHarness>): void {
  it("applies saved memory and project limits to subsequent reservations without interrupting existing attempts", async () => {
    const harness = await createHarness();
    const now = "2026-08-10T00:00:00.000Z";
    const directory = await mkdtemp(resolve(tmpdir(), "live-scheduling-"));
    temporaryDirectories.push(directory);
    const writer = new PlatformConfigurationStore(directory);
    writer.initialize();
    const reader = new PlatformConfigurationStore(directory);
    const configure = (
      memoryAdmissionMode: "reserved" | "threshold" | "disabled",
      projectMaximumConcurrency: number,
    ) => {
      const current = writer.read();
      writer.replace(
        {
          ...current,
          scheduler: { ...current.scheduler, memoryAdmissionMode, projectMaximumConcurrency },
        },
        current.revision,
      );
    };
    try {
      await harness.rawQuery(
        "UPDATE run_batches SET status='succeeded' WHERE project_id=? AND id<>?",
        [harness.projectId, harness.batchQueuedId],
      );
      await harness.rawQuery("UPDATE run_batches SET total_runs=8 WHERE id=?", [
        harness.batchQueuedId,
      ]);
      await harness.rawQuery("INSERT INTO run_batch_runners(batch_id,runner_id) VALUES (?,?)", [
        harness.batchQueuedId,
        harness.runnerId,
      ]);
      await harness.rawQuery(
        `UPDATE runners SET max_concurrency=8,busy_slots=0,labels_json='["linux","java","testng"]',
        cpu_utilization_percent=10,memory_utilization_percent=25,memory_total_bytes=?,memory_available_bytes=?,
        load_average_1m=0,logical_cpu_count=16,metrics_observed_at=?,last_seen_at=? WHERE id=?`,
        [16 * 1024 ** 3, 12 * 1024 ** 3, now, now, harness.runnerId],
      );
      const runIds: string[] = [];
      for (let index = 0; index < 8; index++)
        runIds.push(await insertQueuedRun(harness, harness.batchQueuedId));
      await prepareRefillExecutions(harness, harness.batchQueuedId, runIds, "testng", now);
      const service = new RunBatchSchedulingService(
        harness.batches,
        {} as CaseSuiteRepository,
        {} as RunnerRepository,
        { now: () => new Date(now) },
        { next: () => randomUUID() },
        {
          maximumCpuUtilizationPercent: 85,
          maximumMemoryUtilizationPercent: 85,
          maximumLoadPerCpu: 1,
        },
        45,
        undefined,
        128,
        5,
        undefined,
        undefined,
        undefined,
        undefined,
        () => reader.readScheduler(),
      );
      const reserved = async () =>
        (await harness.batches.getSchedulingSnapshot(harness.batchQueuedId, now))?.candidates[0]
          ?.reservedSlots;
      await service.schedule(harness.batchQueuedId);
      expect(await reserved()).toBe(4);
      configure("threshold", 6);
      await service.schedule(harness.batchQueuedId);
      expect(await reserved()).toBe(6);
      configure("reserved", 1);
      await service.schedule(harness.batchQueuedId);
      expect(await reserved()).toBe(6);
      await harness.rawQuery(
        "UPDATE runners SET memory_utilization_percent=99,memory_available_bytes=0 WHERE id=?",
        [harness.runnerId],
      );
      configure("disabled", 8);
      await service.schedule(harness.batchQueuedId);
      expect(await reserved()).toBe(8);
      const batch = await harness.batches.get(harness.batchQueuedId);
      expect(batch?.attempts).toHaveLength(8);
      expect(batch?.attempts.every((attempt) => attempt.status === "assigned")).toBe(true);
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("seeds paginated execution history and task progress using the active database", async () => {
    const harness = await createHarness();
    const scope = { projectId: harness.projectId, projectVersionId: randomUUID() };
    try {
      await insertExecutionRecordsFixture(
        harness.sqliteDataDirectory,
        scope,
        2,
        postgresConnectionString,
      );
      await insertSuiteProgressFixture(
        harness.sqliteDataDirectory,
        scope,
        [
          { id: "history-all-pass", name: "全部通过", passedRuns: 2 },
          { id: "history-all-fail", name: "全部失败", passedRuns: 0 },
        ],
        postgresConnectionString,
      );
      const batches = await harness.batches.list(20, [scope.projectId], scope.projectVersionId);
      expect(batches).toHaveLength(6);
      expect(new Set(batches.map((batch) => batch.sequenceNumber)).size).toBe(6);
      expect(batches.find((batch) => batch.suiteId === "history-all-pass")).toMatchObject({
        status: "succeeded",
        succeededRuns: 2,
      });
      expect(batches.find((batch) => batch.suiteId === "history-all-fail")).toMatchObject({
        status: "failed",
        failedRuns: 2,
      });
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("reads scoped concurrency counts, shared reservations and DDT requirements without transferring case or runtime bodies", async () => {
    const harness = await createHarness();
    const now = "2026-08-10T00:00:00.000Z";
    try {
      const before = await harness.batches.readConcurrencySnapshot(harness.batchRunningId, now);
      const runningId = await insertQueuedRun(harness, harness.batchRunningId);
      const ghostId = await insertQueuedRun(harness, harness.batchRunningId);
      for (const [runId, status] of [
        [runningId, "running"],
        [ghostId, "failed"],
      ] as const) {
        await harness.rawQuery("UPDATE execution_runs SET status=? WHERE id=?", [status, runId]);
        await harness.rawQuery(
          "INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,scheduling_score,created_at) VALUES (?,?,?,1,'running',1,?)",
          [randomUUID(), runId, harness.runnerId, now],
        );
      }
      const readyId = await insertQueuedRun(harness, harness.batchRunningId);
      const heldId = await insertQueuedRun(harness, harness.batchRunningId);
      await harness.rawQuery(
        "UPDATE execution_runs SET case_type='ddt',class_data_json=? WHERE id=?",
        [JSON.stringify({ privateBody: "case-body-secret".repeat(2000) }), readyId],
      );
      await harness.rawQuery("UPDATE execution_runs SET held_round=2 WHERE id=?", [heldId]);
      await harness.rawQuery("UPDATE run_batches SET adapter_runtime_json=? WHERE id=?", [
        JSON.stringify({
          suiteName: "DDT",
          testName: "DDT",
          environmentAddresses: ["private-env"],
          environmentAddressByRunId: Object.fromEntries(
            Array.from({ length: 2000 }, (_, index) => [`run-${index}`, "private-env"]),
          ),
          fallbackEnvironmentAddress: "private-env",
        }),
        harness.batchRunningId,
      ]);
      const snapshot = await harness.batches.readConcurrencySnapshot(harness.batchRunningId, now, [
        harness.projectId,
      ]);
      expect(snapshot).toMatchObject({
        readyRuns: 1,
        heldRuns: 1,
        runningRuns: 1,
        assignedRuns: 0,
        projectActiveRuns: before!.projectActiveRuns + 1,
      });
      expect(snapshot?.nodes[0]).toMatchObject({
        batchReservedSlots: 1,
        reservedSlots: before!.nodes[0]!.reservedSlots + 1,
      });
      expect(snapshot?.requiredCapabilities).toEqual(
        expect.arrayContaining([
          "adapter:cotest-testng-v1",
          "adapter:ddt-case-id-v1",
          "adapter:ddt-insight-url-v1",
        ]),
      );
      // A capability-incompatible selected Runner must remain visible so the reason can be explained.
      expect(snapshot?.nodes).toHaveLength(1);
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain("private-env");
      expect(serialized).not.toContain("case-body-secret");
      expect(serialized).not.toContain("credentialHash");
      expect(serialized.length).toBeLessThan(10_000);
      expect(
        await harness.batches.readConcurrencySnapshot(harness.batchRunningId, now, []),
      ).toBeNull();
      expect(
        await harness.batches.readConcurrencySnapshot(harness.batchRunningId, now, [randomUUID()]),
      ).toBeNull();
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("reports the persisted dynamic concurrency cap instead of the base policy", async () => {
    const harness = await createHarness();
    const now = "2026-08-10T00:00:00.000Z";
    try {
      await harness.rawQuery("UPDATE run_batches SET current_round=2,policy_json=? WHERE id=?", [
        JSON.stringify({
          executor: "testng",
          concurrency: 40,
          runnerLabels: [],
          artifactPatterns: [],
          retryConcurrencyRules: [{ id: "cap", executionRound: 2, concurrency: 20 }],
        }),
        harness.batchRunningId,
      ]);
      await harness.rawQuery(
        "INSERT INTO run_batch_retry_concurrency_states(batch_id,rule_id,rule_index,concurrency,activated_round,updated_at) VALUES (?,'cap',0,20,2,?)",
        [harness.batchRunningId, now],
      );
      const snapshot = await harness.batches.readConcurrencySnapshot(harness.batchRunningId, now);
      expect(snapshot?.targetConcurrency).toBe(20);
      expect(snapshot?.batch.policy?.concurrency).toBe(40);
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it.each([
    { executionCredit: 0, memoryAdmissionMode: "reserved" as const, expectedTotal: 4 },
    { executionCredit: 4 * 1024 ** 3, memoryAdmissionMode: "reserved" as const, expectedTotal: 6 },
    { executionCredit: 0, memoryAdmissionMode: "threshold" as const, expectedTotal: 8 },
    { executionCredit: 0, memoryAdmissionMode: "disabled" as const, expectedTotal: 8 },
  ])(
    "atomically applies $memoryAdmissionMode admission with $executionCredit bytes measured across batches",
    async ({ executionCredit, memoryAdmissionMode, expectedTotal }) => {
      const harness = await createHarness();
      const now = "2026-08-10T00:00:00.000Z";
      const sourceId = randomUUID();
      const batchIds = [harness.batchRunningId, harness.batchQueuedId];
      try {
        await harness.rawQuery("UPDATE run_batches SET status = 'succeeded' WHERE id = ?", [
          harness.completion.batchId,
        ]);
        await harness.rawQuery(
          `UPDATE runners SET max_concurrency = 32, cpu_utilization_percent = 10,
        memory_utilization_percent = 25, memory_total_bytes = ?, memory_available_bytes = ?, memory_execution_credit_bytes = ?,
        load_average_1m = 0, logical_cpu_count = 16, metrics_observed_at = ? WHERE id = ?`,
          [16 * 1024 ** 3, 12 * 1024 ** 3, executionCredit, now, harness.runnerId],
        );
        await harness.rawQuery("INSERT INTO run_batch_runners(batch_id, runner_id) VALUES (?, ?)", [
          harness.batchQueuedId,
          harness.runnerId,
        ]);
        await harness.rawQuery(
          `INSERT INTO case_sources
        (id,project_id,display_name,original_file_name,object_key,sha256,size_bytes,class_count,method_count,status,warnings_json,inspection_json,created_at,updated_at)
        VALUES (?,?,'Memory fixture','fixture.jar',?, ?,100,1,1,'ready','[]','{}',?,?)`,
          [sourceId, harness.projectId, sourceId, "a".repeat(64), now, now],
        );
        const runIdsByBatch: string[][] = [];
        for (const batchId of batchIds) {
          const runIds: string[] = [];
          for (let index = 0; index < 4; index++) {
            const caseId = randomUUID();
            await harness.rawQuery(
              `INSERT INTO case_definitions(id,project_id,source_id,class_name,package_name,display_name,enabled,groups_json,current_version,created_at,updated_at)
            VALUES (?,?,?,'example.MemoryTest','example','MemoryTest',TRUE,'[]',1,?,?)`,
              [caseId, harness.projectId, sourceId, now, now],
            );
            await harness.rawQuery(
              "INSERT INTO case_versions(id,case_definition_id,source_id,version,snapshot_json,created_at) VALUES (?,?,?,1,'{}',?)",
              [randomUUID(), caseId, sourceId, now],
            );
            const runId = await insertQueuedRun(harness, batchId);
            await harness.rawQuery(
              "UPDATE execution_runs SET case_definition_id = ? WHERE id = ?",
              [caseId, runId],
            );
            runIds.push(runId);
          }
          runIdsByBatch.push(runIds);
        }
        const reserve = (batchId: string, runIds: string[]) =>
          harness.batches.reserveAssignments({
            batchId,
            decisions: runIds.map((executionRunId) => ({
              executionRunId,
              runnerId: harness.runnerId,
              score: 1,
              attemptId: randomUUID(),
              assignmentId: randomUUID(),
            })),
            thresholds: {
              memoryAdmissionMode,
              maximumCpuUtilizationPercent: 80,
              maximumMemoryUtilizationPercent: 85,
              maximumLoadPerCpu: 1,
            },
            runnerLiveCapacities: [
              { runnerId: harness.runnerId, availableSlots: executionCredit ? 30 : 32 },
            ],
            offlineBefore: now,
            metricsFreshAfter: now,
            scheduledAt: now,
          });
        if (executionCredit) {
          // Two measured JVMs already own authoritative reservations; pending work
          // must reserve its entire limit rather than borrowing their credit again.
          expect((await reserve(batchIds[0]!, runIdsByBatch[0]!.slice(0, 2))).reserved).toBe(2);
          await harness.rawQuery("UPDATE runners SET busy_slots=2 WHERE id=?", [harness.runnerId]);
        }
        const reservations = await Promise.all(
          batchIds.map((batchId, index) => reserve(batchId, runIdsByBatch[index]!)),
        );
        expect(reservations.reduce((count, reservation) => count + reservation.reserved, 0)).toBe(
          expectedTotal - (executionCredit ? 2 : 0),
        );
        const snapshot = await harness.batches.getSchedulingSnapshot(harness.batchRunningId, now);
        expect(snapshot?.candidates[0]?.reservedSlots).toBe(expectedTotal);
        expect(snapshot?.candidates[0]?.runner.resourceSnapshot).toMatchObject({
          memoryTotalBytes: 16 * 1024 ** 3,
          memoryAvailableBytes: 12 * 1024 ** 3,
          memoryExecutionCreditBytes: executionCredit,
        });
        // A completed attempt must release its budget without requiring another heartbeat.
        const releasedAttemptId = reservations.flatMap(
          (reservation) => reservation.acceptedAttemptIds,
        )[0]!;
        await harness.rawQuery(
          "UPDATE run_attempts SET status = 'failed', outcome = 'failed' WHERE id = ?",
          [releasedAttemptId],
        );
        const refilled = await Promise.all(
          batchIds.map(async (batchId, index) => {
            const batch = await harness.batches.get(batchId);
            const queuedIds = new Set(
              batch?.runs.filter((run) => run.status === "queued").map((run) => run.id),
            );
            return reserve(
              batchId,
              runIdsByBatch[index]!.filter((runId) => queuedIds.has(runId)),
            );
          }),
        );
        expect(refilled.reduce((count, reservation) => count + reservation.reserved, 0)).toBe(
          memoryAdmissionMode === "reserved" ? 1 : 0,
        );
        const afterRelease = await harness.batches.getSchedulingSnapshot(
          harness.batchRunningId,
          now,
        );
        expect(afterRelease?.candidates[0]?.reservedSlots).toBe(
          memoryAdmissionMode === "reserved" ? expectedTotal : expectedTotal - 1,
        );
      } finally {
        await harness.dispose();
        await cleanupTemporaryDirectories();
      }
    },
  );

  it("records skipped tests as failed runs and failed batch counters", async () => {
    const harness = await createHarness();
    try {
      for (const [attemptId, leaseTokenHash] of [
        [harness.completion.attempt1Id, harness.completion.lease1TokenHash],
        [harness.completion.attempt2Id, harness.completion.lease2TokenHash],
      ]) {
        const completion = await harness.executions.completeAttempt({
          runnerId: harness.runnerId,
          attemptId: attemptId!,
          leaseTokenHash: leaseTokenHash!,
          completionId: randomUUID(),
          resultDigest: randomUUID(),
          eventId: randomUUID(),
          acceptedAt: "2026-08-10T00:05:00.000Z",
          result: normalizeTestNgCompletion({
            status: "succeeded",
            resultCode: "TESTNG_ALL_SKIPPED",
            summary: "old Runner",
            durationMs: 1,
            artifacts: [],
            testNg: {
              total: 1,
              passed: 0,
              failed: 0,
              skipped: 1,
              configurationFailures: 0,
              detailsTruncated: false,
              suites: [],
            },
          }),
        });
        expect(completion.disposition).toBe("accepted");
      }
      const batch = await harness.batches.get(harness.completion.batchId);
      expect(batch).toMatchObject({ succeededRuns: 0, failedRuns: 2 });
      expect(batch?.runs.every((run) => run.terminalOutcome === "failed")).toBe(true);
      expect(batch?.attempts.every((attempt) => attempt.resultCode === "TESTNG_SKIPPED")).toBe(
        true,
      );
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("dispatches only the raw DDT CaseID to capable Runners, without a JSON input", async () => {
    const harness = await createHarness();
    const now = "2026-08-10T00:00:00.000Z";
    const batchId = randomUUID();
    const sourceId = randomUUID();
    const caseDefinitionId = randomUUID();
    const runId = randomUUID();
    const caseId = "支付/0001?x=1 中文";
    const capabilities = [
      "executor:testng-v1",
      "isolation:cgroup-v2",
      "java:21.0.8",
      "testng:7.11.0",
      "adapter:cotest-testng-v1",
      "adapter:ddt-insight-url-v1",
    ];
    const thresholds = {
      maximumCpuUtilizationPercent: 80,
      maximumMemoryUtilizationPercent: 85,
      maximumLoadPerCpu: 1,
    };
    try {
      await harness.rawQuery(
        `INSERT INTO case_sources
        (id, project_id, display_name, original_file_name, object_key, sha256, size_bytes, class_count, method_count, status, warnings_json, inspection_json, created_at, updated_at)
        VALUES (?, ?, 'DDT', 'ddt.jar', ?, ?, 100, 1, 1, 'ready', '[]', '{}', ?, ?)`,
        [sourceId, harness.projectId, sourceId, "a".repeat(64), now, now],
      );
      await harness.rawQuery(
        `INSERT INTO case_definitions
        (id, project_id, source_id, class_name, package_name, display_name, enabled, groups_json, current_version, created_at, updated_at)
        VALUES (?, ?, ?, 'example.DdtTest', 'example', 'DdtTest', TRUE, '[]', 1, ?, ?)`,
        [caseDefinitionId, harness.projectId, sourceId, now, now],
      );
      await harness.rawQuery(
        `INSERT INTO case_versions
        (id, case_definition_id, source_id, version, snapshot_json, created_at) VALUES (?, ?, ?, 1, '{}', ?)`,
        [randomUUID(), caseDefinitionId, sourceId, now],
      );
      await harness.rawQuery(
        `UPDATE runners SET capabilities_json = ?, labels_json = '["linux","java","testng"]', max_concurrency = 8,
        cpu_utilization_percent = 0, memory_utilization_percent = 0, load_average_1m = 0, logical_cpu_count = 4, metrics_observed_at = ? WHERE id = ?`,
        [JSON.stringify(capabilities), now, harness.runnerId],
      );
      await harness.batches.create({
        id: batchId,
        projectId: harness.projectId,
        suiteId: randomUUID(),
        suiteName: "DDT CaseID",
        suiteVersion: 1,
        policy: { executor: "testng", concurrency: 1, runnerLabels: [], artifactPatterns: [] },
        retryLimit: 0,
        environmentVariables: [],
        runnerIds: [harness.runnerId],
        adapterRuntimeSnapshot: { suiteName: "DDT", testName: "DDT", environmentAddresses: [] },
        runs: [
          {
            id: runId,
            caseDefinitionId: randomUUID(),
            caseType: "ddt",
            executionCaseDefinitionId: caseDefinitionId,
            caseVersion: 1,
            displayName: caseId,
            className: "example.DdtTest",
            ddtSrNum: "SR",
          },
        ],
        createdAt: now,
      });
      // A terminal DDT run can retain a stale attempt during recovery; it owns no batch slot.
      const terminalRunId = await insertQueuedRun(harness, batchId);
      await harness.rawQuery(
        "UPDATE execution_runs SET status='failed',case_type='ddt' WHERE id=?",
        [terminalRunId],
      );
      await harness.rawQuery(
        "INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,scheduling_score,created_at) VALUES (?,?,?,1,'running',1,?)",
        [randomUUID(), terminalRunId, harness.runnerId, now],
      );
      const reservation = {
        batchId,
        decisions: [
          {
            executionRunId: runId,
            runnerId: harness.runnerId,
            score: 1,
            attemptId: randomUUID(),
            assignmentId: randomUUID(),
          },
        ],
        thresholds,
        offlineBefore: now,
        metricsFreshAfter: now,
        scheduledAt: now,
      };
      expect((await harness.batches.getSchedulingSnapshot(batchId, now))?.candidates).toEqual([]);
      expect((await harness.batches.reserveAssignments(reservation)).reserved).toBe(0);
      const rerun = await harness.batches.getRerunSnapshot(batchId, { executionRunId: runId });
      expect(rerun?.runs[0]).toMatchObject({
        displayName: caseId,
        caseType: "ddt",
        executionCaseDefinitionId: caseDefinitionId,
      });
      expect(rerun?.runs[0]).not.toHaveProperty("classData");
      capabilities.push("adapter:ddt-case-id-v1");
      await harness.rawQuery("UPDATE runners SET capabilities_json = ? WHERE id = ?", [
        JSON.stringify(capabilities),
        harness.runnerId,
      ]);
      expect((await harness.batches.reserveAssignments(reservation)).reserved).toBe(1);
      const claimed = await harness.executions.claim({
        runnerId: harness.runnerId,
        requestId: randomUUID(),
        availableSlots: 1,
        labels: ["linux", "java", "testng"],
        capabilities,
        now,
        leaseExpiresAt: "2026-08-10T00:01:00.000Z",
        leaseSeeds: [
          {
            id: randomUUID(),
            eventId: randomUUID(),
            tokenHash: "ddt-token",
            tokenEncrypted: "ddt-token",
          },
        ],
      });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.assignment.executionSpec.adapter?.caseId).toBe(caseId);
      expect(claimed[0]?.assignment.executionSpec.requiredCapabilities).toContain(
        "adapter:ddt-case-id-v1",
      );
      expect(claimed[0]?.assignment.executionSpec.inputs.map((input) => input.kind)).toEqual([
        "test-jar",
      ]);
    } finally {
      await harness.rawQuery("DELETE FROM run_batches WHERE id = ?", [batchId]);
      await harness.rawQuery("DELETE FROM case_definitions WHERE id = ?", [caseDefinitionId]);
      await harness.rawQuery("DELETE FROM case_sources WHERE id = ?", [sourceId]);
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("resolves the current project-version dependency for a diagnostic rerun", async () => {
    const harness = await createHarness();
    const projectVersionId = randomUUID();
    const currentBundleId = randomUUID();
    const sourceBatchId = randomUUID();
    const sourceRunId = randomUUID();
    const diagnosticBatchId = randomUUID();
    const diagnosticRunId = randomUUID();
    const recordedAt = "2026-08-10T00:06:00.000Z";
    const policy = {
      executor: "testng" as const,
      concurrency: 1,
      projectVersionId,
      runnerLabels: [],
      artifactPatterns: [],
      retryConcurrencyRules: [],
    };
    const sourceRun = {
      id: sourceRunId,
      caseDefinitionId: randomUUID(),
      caseVersion: 3,
      displayName: "Dependency refresh",
      className: "example.DependencyRefreshTest",
    };
    try {
      await harness.rawQuery(
        `INSERT INTO project_versions
           (id, project_id, name, normalized_name, status, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', 1, ?, ?)`,
        [
          projectVersionId,
          harness.projectId,
          `Dependency refresh ${projectVersionId}`,
          `dependency-refresh-${projectVersionId}`,
          recordedAt,
          recordedAt,
        ],
      );
      await harness.rawQuery(
        `INSERT INTO project_runtime_assets
           (id, project_id, kind, source_type, file_name, url, sha256, size_bytes,
            archive_format, created_at)
         VALUES (?, ?, 'jar-bundle', 'url', 'current-dependencies.tar.gz',
                 'https://assets.example.test/current-dependencies.tar.gz', ?, 4096,
                 'tar.gz', ?)`,
        [currentBundleId, harness.projectId, "c".repeat(64), recordedAt],
      );
      await harness.rawQuery(
        `INSERT INTO project_version_runtime_assets
           (project_version_id, project_id, jar_bundle_asset_id, revision, updated_at)
         VALUES (?, ?, ?, 1, ?)`,
        [projectVersionId, harness.projectId, currentBundleId, recordedAt],
      );

      await harness.batches.create({
        id: sourceBatchId,
        projectId: harness.projectId,
        suiteId: randomUUID(),
        suiteName: "Historical dependency source",
        suiteVersion: 1,
        retryLimit: 0,
        environmentVariables: [],
        runnerIds: [],
        policy,
        adapterRuntimeSnapshot: {
          suiteName: "adapter-suite",
          testName: "adapter-test",
          environmentAddresses: ["10.0.0.11"],
          jarBundle: {
            id: "historical-bundle",
            sourceType: "upload",
            sha256: "b".repeat(64),
            sizeBytes: 2048,
            archiveFormat: "zip",
            createdAt: "2026-08-09T00:00:00.000Z",
          },
        },
        runs: [sourceRun],
        createdAt: recordedAt,
      });
      await harness.batches.create({
        id: diagnosticBatchId,
        projectId: harness.projectId,
        suiteId: randomUUID(),
        suiteName: "Current dependency diagnostic",
        suiteVersion: 1,
        kind: "case_log_rerun",
        parentBatchId: sourceBatchId,
        sourceExecutionRunId: sourceRunId,
        retryLimit: 0,
        environmentVariables: [],
        runnerIds: [],
        policy,
        adapter: {
          enabled: true,
          suiteName: "adapter-suite",
          testName: "adapter-test",
          environmentAddresses: ["10.0.0.12"],
        },
        runs: [{ ...sourceRun, id: diagnosticRunId }],
        createdAt: recordedAt,
      });

      await expect(
        harness.batches.getRerunSnapshot(sourceBatchId, { executionRunId: sourceRunId }),
      ).resolves.toMatchObject({
        adapterRuntime: {
          jarBundle: { id: "historical-bundle", createdAt: "2026-08-09T00:00:00.000Z" },
        },
      });
      await expect(
        harness.batches.getRerunSnapshot(diagnosticBatchId, {
          executionRunId: diagnosticRunId,
        }),
      ).resolves.toMatchObject({
        adapterRuntime: {
          environmentAddresses: ["10.0.0.12"],
          jarBundle: { id: currentBundleId, createdAt: recordedAt },
        },
      });
      const newBatchId = randomUUID();
      const newRunId = randomUUID();
      await harness.batches.create({
        id: newBatchId,
        projectId: harness.projectId,
        suiteId: randomUUID(),
        suiteName: "New task after dependency publication",
        suiteVersion: 1,
        retryLimit: 0,
        environmentVariables: [],
        runnerIds: [],
        policy,
        adapter: { enabled: true, suiteName: "suite", testName: "test", environmentAddresses: [] },
        runs: [{ ...sourceRun, id: newRunId }],
        createdAt: recordedAt,
      });
      await expect(
        harness.batches.getRerunSnapshot(newBatchId, { executionRunId: newRunId }),
      ).resolves.toMatchObject({
        adapterRuntime: { jarBundle: { id: currentBundleId, createdAt: recordedAt } },
      });
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

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
    const earlierFailedAttemptId = randomUUID();
    const finalFailedAttemptId = randomUUID();
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
                 '2026-08-10T00:01:10.000Z', '2026-08-10T00:01:11.000Z'),
                (?, ?, ?, 2, 'failed', 0.8, 'TEST_ASSERTION_FAILED_FINAL', 180,
                 '2026-08-10T00:01:20.000Z', '2026-08-10T00:01:21.000Z'),
                (?, ?, ?, 1, 'failed', 0.8, 'TEST_ASSERTION_FAILED', 200,
                 '2026-08-10T00:02:10.000Z', '2026-08-10T00:02:11.000Z'),
                (?, ?, ?, 2, 'succeeded', 0.9, 'TESTNG_SUCCEEDED', 120,
                 '2026-08-10T00:02:20.000Z', '2026-08-10T00:02:21.000Z')`,
        [
          earlierFailedAttemptId,
          visibleRunIds[1],
          harness.runnerId,
          finalFailedAttemptId,
          visibleRunIds[1],
          harness.runnerId,
          firstAttemptId,
          visibleRunIds[2],
          harness.runnerId,
          secondAttemptId,
          visibleRunIds[2],
          harness.runnerId,
        ],
      );
      await harness.rawQuery(
        `UPDATE run_attempts SET started_at=created_at
         WHERE execution_run_id IN (?, ?)`,
        [visibleRunIds[1], visibleRunIds[2]],
      );

      await expect(harness.batches.list(100)).resolves.not.toContainEqual(
        expect.objectContaining({ id: harness.batchQueuedId }),
      );
      await expect(harness.batches.get(harness.batchQueuedId)).resolves.toMatchObject({
        id: harness.batchQueuedId,
        kind: "case_log_rerun",
        requestedBy: { username: "c12345678", source: "ldap" },
      });
      const activity = await harness.listCaseActivity(caseDefinitionId, 20);
      expect(activity).toMatchObject({
        executions: [...visibleRunIds].reverse().map((runId) => ({ runId })),
      });
      expect(activity.executions[0]).toMatchObject({ attemptId: secondAttemptId });
      expect(activity.executions[1]).toMatchObject({ attemptId: finalFailedAttemptId });
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
          id: secondAttemptId,
          attemptNumber: 2,
          runnerName: "runner-refill",
          resultCode: "TESTNG_SUCCEEDED",
        }),
      ]);
      expect(firstPage.items[1]?.attempts).toEqual([
        expect.objectContaining({
          id: finalFailedAttemptId,
          attemptNumber: 2,
          resultCode: "TEST_ASSERTION_FAILED_FINAL",
        }),
      ]);
      expect(firstPage.nextCursor).toBeUndefined();
      const finalPage = await harness.listCaseExecutionHistory(caseDefinitionId, {
        cursor: Buffer.from(`2026-08-10T00:01:00.000Z|${visibleRunIds[1]}`).toString("base64url"),
        limit: 2,
      });
      expect(finalPage.items).toEqual([]);
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

  it("retains each case's last executed result in interrupted batches instead of a preferred success", async () => {
    const harness = await createHarness();
    try {
      for (const batchStatus of ["cancelled", "failed"] as const) {
        const thirdRoundCase = `case-third-round-${randomUUID()}`;
        const thirdRound = await insertCaseHistoryRun(harness, thirdRoundCase, {
          batchStatus,
          status: "cancelled",
          attempts: [{ status: "failed" }, { status: "failed" }, { status: "timed_out" }],
        });
        const examples: Array<{
          attempts: Parameters<typeof insertCaseHistoryRun>[2]["attempts"];
          selected: number;
          status: "succeeded" | "failed" | "cancelled";
        }> = [
          { attempts: [{ status: "succeeded" }], selected: 0, status: "succeeded" },
          {
            attempts: [{ status: "failed" }, { status: "succeeded" }],
            selected: 1,
            status: "succeeded",
          },
          { attempts: [{ status: "failed" }, { status: "failed" }], selected: 1, status: "failed" },
          {
            attempts: [{ status: "succeeded" }, { status: "failed" }],
            selected: 1,
            status: "failed",
          },
          {
            attempts: [{ status: "failed" }, { status: "cancelled", started: false }],
            selected: 0,
            status: "failed",
          },
          {
            attempts: [{ status: "failed" }, { status: "cancelled" }],
            selected: 1,
            status: "cancelled",
          },
          {
            attempts: [{ status: "failed" }, { status: "succeeded", executionRound: 1 }],
            selected: 1,
            status: "succeeded",
          },
        ];
        for (const example of examples) {
          const caseId = `case-last-round-${randomUUID()}`;
          const record = await insertCaseHistoryRun(harness, caseId, {
            batchId: thirdRound.batchId,
            status: "cancelled",
            attempts: example.attempts,
          });
          const page = await harness.listCaseExecutionHistory(caseId, {
            limit: 50,
            includeRunnerNames: true,
          });
          expect(page.items).toEqual([
            expect.objectContaining({
              batchId: thirdRound.batchId,
              runId: record.runId,
              status: example.status,
              attempts: [
                expect.objectContaining({
                  id: record.attemptIds[example.selected],
                  attemptNumber: example.selected + 1,
                  executionRound:
                    example.attempts[example.selected]?.executionRound ?? example.selected + 1,
                  runnerName: "runner-refill",
                }),
              ],
            }),
          ]);
        }
        await expect(
          harness.listCaseExecutionHistory(thirdRoundCase, { limit: 50 }),
        ).resolves.toMatchObject({
          items: [
            {
              status: "failed",
              attempts: [{ id: thirdRound.attemptIds[2], executionRound: 3, status: "timed_out" }],
            },
          ],
        });
        for (const attempts of [[], [{ status: "cancelled", started: false }]] as const) {
          const neverStartedCase = `case-never-started-${randomUUID()}`;
          await insertCaseHistoryRun(harness, neverStartedCase, {
            batchId: thirdRound.batchId,
            status: "cancelled",
            attempts: [...attempts],
          });
          await expect(
            harness.listCaseExecutionHistory(neverStartedCase, { limit: 50 }),
          ).resolves.toEqual({ items: [] });
        }
      }
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("preserves executed history when manual termination cancels an unclaimed retry", async () => {
    const harness = await createHarness();
    const caseId = `case-manual-termination-${randomUUID()}`;
    const neverStartedCase = `case-unclaimed-${randomUUID()}`;
    try {
      const record = await insertCaseHistoryRun(harness, caseId, {
        status: "assigned",
        attempts: [{ status: "failed" }, { status: "assigned", started: false, finished: false }],
      });
      await insertCaseHistoryRun(harness, neverStartedCase, {
        batchId: record.batchId,
        status: "queued",
        attempts: [],
      });
      await harness.rawQuery("UPDATE run_batches SET total_runs = 2 WHERE id = ?", [
        record.batchId,
      ]);
      await expect(
        harness.executions.terminateBatch({
          batchId: record.batchId,
          actorId: "history-operator",
          reason: "Manual termination before retry claim",
          eventId: randomUUID(),
          requestedAt: "2026-08-10T00:01:00.000Z",
        }),
      ).resolves.toBe(2);
      await expect(harness.batches.get(record.batchId)).resolves.toMatchObject({
        status: "cancelled",
      });
      await expect(harness.listCaseExecutionHistory(caseId, { limit: 50 })).resolves.toMatchObject({
        items: [
          {
            runId: record.runId,
            status: "failed",
            attempts: [{ id: record.attemptIds[0], executionRound: 1 }],
          },
        ],
      });
      await expect(
        harness.listCaseExecutionHistory(neverStartedCase, { limit: 50 }),
      ).resolves.toEqual({ items: [] });
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("keeps the last finished attempt while later work is queued, unclaimed or still running", async () => {
    const harness = await createHarness();
    const caseId = `case-completed-history-${randomUUID()}`;
    try {
      const expected: string[] = [];
      for (const status of ["queued", "assigned", "running", "cancelled"] as const) {
        const record = await insertCaseHistoryRun(harness, caseId, {
          status,
          attempts: [{ status: "failed" }, { status: "assigned", started: false, finished: false }],
        });
        expected.push(record.runId);
      }
      const running = await insertCaseHistoryRun(harness, caseId, {
        status: "running",
        attempts: [{ status: "succeeded" }, { status: "running", finished: false }],
      });
      expected.push(running.runId);
      const outcome = await insertCaseHistoryRun(harness, caseId, {
        status: "failed",
        attempts: [{ status: "failed", outcome: "cancelled" }],
      });
      expected.push(outcome.runId);
      const hidden = [
        [],
        [{ status: "assigned", started: false, finished: false }],
        [{ status: "running", finished: false }],
        [{ status: "cancelled", started: false }],
        [{ status: "failed", started: false }],
        [{ status: "failed", finished: false }],
      ] satisfies Array<Parameters<typeof insertCaseHistoryRun>[2]["attempts"]>;
      for (const attempts of hidden) {
        await insertCaseHistoryRun(harness, caseId, { status: "cancelled", attempts });
      }
      await insertCaseHistoryRun(harness, caseId, {
        status: "failed",
        diagnostic: true,
        attempts: [{ status: "failed" }],
      });
      const page = await harness.listCaseExecutionHistory(caseId, { limit: 50 });
      expect(page.items.map((item) => item.runId).sort()).toEqual(expected.sort());
      expect(page.items.every((item) => item.attempts.length === 1)).toBe(true);
      expect(page.items.find((item) => item.runId === running.runId)).toMatchObject({
        status: "succeeded",
        attempts: [{ id: running.attemptIds[0] }],
      });
      expect(page.items.find((item) => item.runId === outcome.runId)).toMatchObject({
        status: "cancelled",
      });
      expect(page.nextCursor).toBeUndefined();
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("filters never-started records before cursor pagination without losing older executed results", async () => {
    const harness = await createHarness();
    const caseId = `case-paged-history-${randomUUID()}`;
    try {
      const fixture = await insertCaseExecutionHistoryFixture({
        ...(harness.sqliteDataDirectory
          ? { directory: harness.sqliteDataDirectory }
          : { postgresUrl: postgresConnectionString! }),
        projectId: harness.projectId,
        projectVersionId: "history-version",
        caseId,
        runnerId: harness.runnerId,
        completedCount: 3,
      });
      const page = await harness.listCaseExecutionHistory(caseId, { limit: 2 });
      expect(page.items.map((item) => item.runId)).toEqual(fixture.completedRunIds.slice(0, 2));
      expect(page.items[0]?.attempts[0]).not.toHaveProperty("runnerName");
      expect(page.nextCursor).toBeTruthy();
      const older = await harness.listCaseExecutionHistory(caseId, {
        limit: 2,
        cursor: page.nextCursor!,
      });
      expect(older.items.map((item) => item.runId)).toEqual(fixture.completedRunIds.slice(2));
      expect(older.nextCursor).toBeUndefined();
      await expect(
        harness.listCaseExecutionHistory("no-executions", { limit: 2 }),
      ).resolves.toEqual({
        items: [],
      });
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

  it("calculates the prior logical-round pass rate from each run's last physical attempt", async () => {
    const harness = await createHarness();
    const runId = randomUUID();
    const runnerFailureAttemptId = randomUUID();
    const successfulAttemptId = randomUUID();
    const recordedAt = "2026-08-10T00:03:00.000Z";
    try {
      await harness.rawQuery(
        "UPDATE run_batches SET retry_mode = 'round', current_round = 2 WHERE id = ?",
        [harness.batchQueuedId],
      );
      await harness.rawQuery(
        `INSERT INTO execution_runs
           (id, batch_id, case_definition_id, case_version, display_name, class_name, status,
            attempt_count, execution_round, terminal_outcome, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'Logical round retry', 'example.LogicalRoundRetryTest',
                 'succeeded', 2, 1, 'succeeded', ?, ?)`,
        [runId, harness.batchQueuedId, `case-${runId}`, recordedAt, recordedAt],
      );
      await harness.rawQuery(
        `INSERT INTO run_attempts
           (id, execution_run_id, runner_id, attempt_number, execution_round, status, outcome,
            result_code, scheduling_score, created_at, finished_at)
         VALUES (?, ?, ?, 1, 1, 'failed', 'failed', 'PROCESS_START_FAILED', 0.5, ?, ?),
                (?, ?, ?, 2, 1, 'succeeded', 'succeeded', 'TESTNG_SUCCEEDED', 0.7, ?, ?)`,
        [
          runnerFailureAttemptId,
          runId,
          harness.runnerId,
          recordedAt,
          recordedAt,
          successfulAttemptId,
          runId,
          harness.runnerId,
          recordedAt,
          recordedAt,
        ],
      );

      const snapshot = await harness.batches.getSchedulingSnapshot(
        harness.batchQueuedId,
        "2026-08-10T00:00:00.000Z",
      );
      expect(snapshot?.retryContext).toMatchObject({
        executionRound: 2,
        previousRoundPassRate: 100,
      });
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

  it.each(["testng", "ddt"] as const)(
    "skips a full 40-case %s batch so the other task type can refill one slot",
    async (blockedType) => {
      const harness = await createHarness();
      const now = "2026-08-10T00:10:00.000Z";
      try {
        const policy = JSON.stringify({
          executor: "testng",
          concurrency: 40,
          runnerLabels: [],
          artifactPatterns: [],
        });
        const queuedRunByBatch = new Map<string, string>();
        for (const batchId of [harness.batchRunningId, harness.batchQueuedId]) {
          await harness.rawQuery(
            "UPDATE run_batches SET policy_json = ?, status = 'running' WHERE id = ?",
            [policy, batchId],
          );
          queuedRunByBatch.set(batchId, await insertQueuedRun(harness, batchId));
        }
        const waitingType = blockedType === "testng" ? "ddt" : "testng";
        await harness.rawQuery("UPDATE execution_runs SET case_type=? WHERE batch_id=?", [
          blockedType,
          harness.batchRunningId,
        ]);
        await harness.rawQuery("UPDATE execution_runs SET case_type=? WHERE batch_id=?", [
          waitingType,
          harness.batchQueuedId,
        ]);
        await harness.rawQuery("UPDATE run_batches SET priority = 100 WHERE id = ?", [
          harness.batchRunningId,
        ]);
        await harness.rawQuery("INSERT INTO run_batch_runners(batch_id,runner_id) VALUES (?,?)", [
          harness.batchQueuedId,
          harness.runnerId,
        ]);
        const blockedRuns: string[] = [];
        for (const [batchId, count, caseType] of [
          [harness.batchRunningId, 40, blockedType],
          [harness.batchQueuedId, 5, waitingType],
        ] as const) {
          for (let index = 0; index < count; index++) {
            const runId = await insertQueuedRun(harness, batchId);
            await harness.rawQuery(
              "UPDATE execution_runs SET status='running',case_type=? WHERE id=?",
              [caseType, runId],
            );
            await harness.rawQuery(
              "INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,scheduling_score,created_at) VALUES (?,?,?,1,'running',1,?)",
              [randomUUID(), runId, harness.runnerId, now],
            );
            if (caseType === blockedType) blockedRuns.push(runId);
          }
        }
        expect(
          await harness.batches.listSchedulableBatchIdsForRunner(harness.runnerId, 1, now),
        ).toEqual([harness.batchQueuedId]);
        expect((await harness.batches.listSchedulableBatchIds(10, now))[0]).toBe(
          harness.batchQueuedId,
        );
        // Preserve legacy policy semantics: NULL has no cap; an empty object defaults to four.
        await harness.rawQuery("UPDATE run_batches SET policy_json=NULL WHERE id=?", [
          harness.batchRunningId,
        ]);
        expect(
          await harness.batches.listSchedulableBatchIdsForRunner(harness.runnerId, 1, now),
        ).toEqual([harness.batchRunningId]);
        await harness.rawQuery("UPDATE run_batches SET policy_json='{}' WHERE id=?", [
          harness.batchRunningId,
        ]);
        expect(
          await harness.batches.listSchedulableBatchIdsForRunner(harness.runnerId, 1, now),
        ).toEqual([harness.batchQueuedId]);
        // The active rule, rather than the original base setting, owns the current cap.
        await harness.rawQuery("UPDATE run_batches SET policy_json=?, current_round=2 WHERE id=?", [
          JSON.stringify({
            executor: "testng",
            concurrency: 80,
            retryConcurrencyRules: [{ id: "cap", executionRound: 2, concurrency: 40 }],
            runnerLabels: [],
            artifactPatterns: [],
          }),
          harness.batchRunningId,
        ]);
        await harness.rawQuery(
          "INSERT INTO run_batch_retry_concurrency_states(batch_id,rule_id,rule_index,concurrency,activated_round,updated_at) VALUES (?,'cap',0,40,2,?)",
          [harness.batchRunningId, now],
        );
        expect(
          await harness.batches.listSchedulableBatchIdsForRunner(harness.runnerId, 1, now),
        ).toEqual([harness.batchQueuedId]);
        // Assigned-but-unclaimed work consumes the same budget as running attempts.
        await harness.rawQuery(
          "UPDATE run_attempts SET status='assigned' WHERE execution_run_id=?",
          [blockedRuns[0]!],
        );
        await harness.rawQuery("UPDATE execution_runs SET status='assigned' WHERE id=?", [
          blockedRuns[0]!,
        ]);
        expect(
          await harness.batches.listSchedulableBatchIdsForRunner(harness.runnerId, 1, now),
        ).toEqual([harness.batchQueuedId]);
        await refillAndClaimWaitingTask(
          harness,
          queuedRunByBatch.get(harness.batchQueuedId)!,
          waitingType,
          now,
        );
        expect((await harness.batches.getSummary(harness.batchQueuedId))?.assignedRuns).toBe(6);
        expect((await harness.batches.getSummary(harness.batchRunningId))?.assignedRuns).toBe(40);
        // Releasing a real slot makes the higher-priority task eligible again.
        await harness.rawQuery(
          "UPDATE run_attempts SET status='succeeded' WHERE execution_run_id=?",
          [blockedRuns[0]!],
        );
        await harness.rawQuery("UPDATE execution_runs SET status='succeeded' WHERE id=?", [
          blockedRuns[0]!,
        ]);
        expect(
          await harness.batches.listSchedulableBatchIdsForRunner(harness.runnerId, 1, now),
        ).toEqual([harness.batchRunningId]);
      } finally {
        await harness.dispose();
        await cleanupTemporaryDirectories();
      }
    },
  );

  it.each(["testng", "ddt"] as const)(
    "lets a later %s task refill before an older task reclaims the shared slot",
    async (laterType) => {
      const harness = await createHarness();
      const now = "2026-08-10T00:10:00.000Z";
      try {
        await harness.rawQuery("INSERT INTO run_batch_runners(batch_id,runner_id) VALUES (?,?)", [
          harness.batchQueuedId,
          harness.runnerId,
        ]);
        let laterQueuedRunId = "";
        for (const [batchId, caseType, concurrency, activeCount, scheduledFor] of [
          [
            harness.batchRunningId,
            laterType === "ddt" ? "testng" : "ddt",
            30,
            29,
            "2026-08-10T00:00:00.000Z",
          ],
          [harness.batchQueuedId, laterType, 40, 5, "2026-08-10T00:09:30.000Z"],
        ] as const) {
          await harness.rawQuery(
            "UPDATE run_batches SET status='running',priority=0,scheduled_for=?,policy_json=? WHERE id=?",
            [
              scheduledFor,
              JSON.stringify({
                executor: "testng",
                concurrency,
                runnerLabels: [],
                artifactPatterns: [],
              }),
              batchId,
            ],
          );
          const queuedRunId = await insertQueuedRun(harness, batchId);
          if (batchId === harness.batchQueuedId) laterQueuedRunId = queuedRunId;
          await harness.rawQuery("UPDATE execution_runs SET case_type=? WHERE id=?", [
            caseType,
            queuedRunId,
          ]);
          for (let index = 0; index < activeCount; index++) {
            const runId = await insertQueuedRun(harness, batchId);
            await harness.rawQuery(
              "UPDATE execution_runs SET status='running',case_type=? WHERE id=?",
              [caseType, runId],
            );
            await harness.rawQuery(
              "INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,scheduling_score,created_at) VALUES (?,?,?,1,'running',1,?)",
              [randomUUID(), runId, harness.runnerId, now],
            );
          }
        }
        // The first task has just completed one case: 30 -> 29. Both tasks can accept work.
        // Its older creation time must not give it every released slot ahead of the task at five.
        expect(
          await harness.batches.listSchedulableBatchIdsForRunner(harness.runnerId, 1, now),
        ).toEqual([harness.batchQueuedId]);
        expect((await harness.batches.listSchedulableBatchIds(10, now))[0]).toBe(
          harness.batchQueuedId,
        );
        await refillAndClaimWaitingTask(harness, laterQueuedRunId, laterType, now, {
          maxConcurrency: 35,
          busySlots: 34,
        });
        expect((await harness.batches.getSummary(harness.batchQueuedId))?.assignedRuns).toBe(6);
        expect((await harness.batches.getSummary(harness.batchRunningId))?.assignedRuns).toBe(29);
        // Explicit priority still takes precedence over equal-priority balancing.
        await harness.rawQuery("UPDATE run_batches SET priority=1 WHERE id=?", [
          harness.batchRunningId,
        ]);
        expect(
          await harness.batches.listSchedulableBatchIdsForRunner(harness.runnerId, 1, now),
        ).toEqual([harness.batchRunningId]);
      } finally {
        await harness.dispose();
        await cleanupTemporaryDirectories();
      }
    },
  );

  it.each([40, 128])(
    "shares eight ten-slot Runners between 30-case and 40-case tasks under project budget %i",
    async (projectMaximumConcurrency) => {
      const harness = await createHarness();
      const now = "2026-08-10T00:10:00.000Z";
      const additionalRunnerIds: string[] = [];
      try {
        await harness.rawQuery(
          "UPDATE run_batches SET status='succeeded' WHERE project_id=? AND id NOT IN (?,?)",
          [harness.projectId, harness.batchRunningId, harness.batchQueuedId],
        );
        await harness.rawQuery(
          `UPDATE runners SET max_concurrency=10,busy_slots=0,
            labels_json='["linux","java","testng"]',
            capabilities_json='["executor:testng-v1","isolation:cgroup-v2","java:21.0.8","testng:7.11.0","adapter:cotest-testng-v1","adapter:ddt-case-id-v1","adapter:ddt-insight-url-v1"]',
            cpu_utilization_percent=30,memory_utilization_percent=12.5,
            memory_total_bytes=?,memory_available_bytes=?,load_average_1m=0,
            logical_cpu_count=16,metrics_observed_at=?,last_seen_at=? WHERE id=?`,
          [32 * 1024 ** 3, 28 * 1024 ** 3, now, now, harness.runnerId],
        );
        for (let index = 1; index < 8; index++) {
          const runnerId = randomUUID();
          await harness.rawQuery(
            `INSERT INTO runners
              (id,credential_hash,name,os,architecture,agent_version,protocol_version,
               labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,
               created_at,updated_at,cpu_utilization_percent,memory_utilization_percent,
               memory_total_bytes,memory_available_bytes,load_average_1m,logical_cpu_count,metrics_observed_at)
              SELECT ?,?,?,'linux','amd64','0.2.2',1,labels_json,capabilities_json,10,0,
                ?,?,?,30,12.5,memory_total_bytes,memory_available_bytes,0,16,?
              FROM runners WHERE id=?`,
            [runnerId, `hash-${runnerId}`, `Runner ${index}`, now, now, now, now, harness.runnerId],
          );
          additionalRunnerIds.push(runnerId);
        }
        for (const [batchId, caseType, concurrency] of [
          [harness.batchRunningId, "testng", 30],
          [harness.batchQueuedId, "ddt", 40],
        ] as const) {
          for (const runnerId of [harness.runnerId, ...additionalRunnerIds]) {
            await harness.rawQuery(
              "INSERT INTO run_batch_runners(batch_id,runner_id) VALUES (?,?) ON CONFLICT DO NOTHING",
              [batchId, runnerId],
            );
          }
          await harness.rawQuery("UPDATE run_batches SET policy_json=?,total_runs=? WHERE id=?", [
            JSON.stringify({
              executor: "testng",
              concurrency,
              runnerLabels: [],
              artifactPatterns: [],
            }),
            concurrency,
            batchId,
          ]);
          const queuedRunIds: string[] = [];
          for (let index = 0; index < concurrency; index++) {
            queuedRunIds.push(await insertQueuedRun(harness, batchId));
          }
          await prepareRefillExecutions(harness, batchId, queuedRunIds, caseType, now);
        }
        const scheduling = refillSchedulingService(harness, now, projectMaximumConcurrency);
        await scheduling.schedule(harness.batchRunningId);
        await scheduling.schedule(harness.batchQueuedId);
        expect((await harness.batches.getSummary(harness.batchRunningId))?.assignedRuns).toBe(30);
        expect((await harness.batches.getSummary(harness.batchQueuedId))?.assignedRuns).toBe(
          projectMaximumConcurrency === 40 ? 10 : 40,
        );
        const snapshot = await harness.batches.getSchedulingSnapshot(harness.batchQueuedId, now);
        expect(snapshot?.projectActiveRuns).toBe(Math.min(70, projectMaximumConcurrency));
        expect(snapshot?.candidates).toHaveLength(8);
        expect(snapshot?.candidates.every((candidate) => candidate.reservedSlots <= 10)).toBe(true);
        const nodeCounts = snapshot!.candidates.map((candidate) => candidate.reservedSlots);
        expect(Math.max(...nodeCounts) - Math.min(...nodeCounts)).toBeLessThanOrEqual(1);
        // When the first task ends, its project and Runner reservations belong to the shared pool.
        await harness.rawQuery(
          "UPDATE run_attempts SET status='succeeded' WHERE execution_run_id IN (SELECT id FROM execution_runs WHERE batch_id=?)",
          [harness.batchRunningId],
        );
        await harness.rawQuery("UPDATE execution_runs SET status='succeeded' WHERE batch_id=?", [
          harness.batchRunningId,
        ]);
        await harness.rawQuery("UPDATE assignments SET status='completed' WHERE batch_id=?", [
          harness.batchRunningId,
        ]);
        await harness.rawQuery("UPDATE run_batches SET status='succeeded' WHERE id=?", [
          harness.batchRunningId,
        ]);
        await scheduling.scheduleForRunner(harness.runnerId);
        expect((await harness.batches.getSummary(harness.batchQueuedId))?.assignedRuns).toBe(40);
        const refilled = await harness.batches.getSchedulingSnapshot(harness.batchQueuedId, now);
        expect(refilled?.projectActiveRuns).toBe(40);
        expect(refilled?.candidates.every((candidate) => candidate.reservedSlots <= 10)).toBe(true);
      } finally {
        try {
          await harness.rawQuery("DELETE FROM run_batches WHERE project_id=?", [harness.projectId]);
          for (const runnerId of additionalRunnerIds) {
            await harness.rawQuery("DELETE FROM runners WHERE id=?", [runnerId]);
          }
        } finally {
          await harness.dispose();
          await cleanupTemporaryDirectories();
        }
      }
    },
  );

  it("preserves waiting-time promotion for a lower-priority task with no in-flight work", async () => {
    const harness = await createHarness();
    const now = "2026-08-10T00:10:00.000Z";
    try {
      await harness.rawQuery("INSERT INTO run_batch_runners(batch_id,runner_id) VALUES (?,?)", [
        harness.batchQueuedId,
        harness.runnerId,
      ]);
      await insertQueuedRun(harness, harness.batchQueuedId);
      await insertQueuedRun(harness, harness.batchRunningId);
      const activeRunId = await insertQueuedRun(harness, harness.batchRunningId);
      await harness.rawQuery("UPDATE execution_runs SET status='running' WHERE id=?", [
        activeRunId,
      ]);
      await harness.rawQuery(
        "INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,scheduling_score,created_at) VALUES (?,?,?,1,'running',1,?)",
        [randomUUID(), activeRunId, harness.runnerId, now],
      );
      await harness.rawQuery(
        "UPDATE run_batches SET priority=-1,scheduled_for='2026-08-09T23:00:00.000Z' WHERE id=?",
        [harness.batchQueuedId],
      );
      expect(
        await harness.batches.listSchedulableBatchIdsForRunner(harness.runnerId, 1, now),
      ).toEqual([harness.batchQueuedId]);
      await harness.rawQuery("UPDATE run_batches SET scheduled_for=? WHERE id=?", [
        now,
        harness.batchQueuedId,
      ]);
      expect(
        await harness.batches.listSchedulableBatchIdsForRunner(harness.runnerId, 1, now),
      ).toEqual([harness.batchRunningId]);
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
      expect(snapshot?.batch.currentRound).toBe(1);
      const details = await harness.batches.get(completion.batchId);
      expect(details?.runs).toContainEqual(
        expect.objectContaining({
          status: "queued",
          executionRound: 1,
          attemptCount: 1,
        }),
      );
      expect(details?.attempts).toContainEqual(
        expect.objectContaining({
          id: completion.attempt1Id,
          attemptNumber: 1,
          executionRound: 1,
        }),
      );
      const overview = await harness.batches.getDetailOverview(completion.batchId);
      expect(overview?.roundSummaries.map((round) => round.round)).toEqual([1]);
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
