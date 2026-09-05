import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { CaseSuiteActivityService } from "@autoforge/application";
import {
  DEFAULT_PROJECT_ID,
  defaultCaseSuiteExecutionPolicy,
  type RunBatchKind,
  type RunBatchStatus,
} from "@autoforge/domain";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteCaseSuiteActivityRepository } from "../src/sqlite-case-suite-activity";
import { PostgresCaseSuiteActivityRepository } from "../src/postgres-case-suite-activity";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import { PostgresCaseSuiteRepository } from "../src/postgres-platform-repository";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";
import { SqlitePlatformOperationsRepository } from "../src/sqlite-platform-operations";
import { PostgresPlatformOperationsRepository } from "../src/postgres-platform-operations";
import { executionRuns, projects, runAttempts, runBatches, runners } from "../src/schema";
import {
  pgCaseSuites,
  pgExecutionRuns,
  pgRunAttempts,
  pgRunBatches,
  pgRunners,
  pgProjects,
} from "../src/postgres-schema";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const NOW = "2026-09-05T12:00:00.000Z";
const WINDOW_START = "2026-08-29T12:00:00.000Z";
const scope = { projectId: DEFAULT_PROJECT_ID, projectVersionId: "activity-version-a" };
type Adapter = "SQLite" | "PostgreSQL";
type Outcome = "succeeded" | "failed" | "timed_out" | "cancelled";
type BatchFixture = {
  id: string;
  createdAt?: string;
  status?: RunBatchStatus;
  kind?: RunBatchKind;
  projectId?: string;
  projectVersionId?: string;
  suiteId?: string;
  cases?: Array<{ outcome: Outcome; attempts?: Outcome[] }>;
};

for (const adapter of ["SQLite", "PostgreSQL"] as const) {
  describe.skipIf(adapter === "PostgreSQL" && !connectionString)(
    `${adapter} case suite activity contract`,
    () => {
      it("averages completed batches equally and counts active batches without averaging unfinished results", async () => {
        await withHarness(adapter, async ({ seedBatch, service, suiteId }) => {
          await seedBatch({ id: "half", cases: [{ outcome: "succeeded" }, { outcome: "failed" }] });
          await seedBatch({
            id: "all",
            cases: Array.from({ length: 4 }, () => ({ outcome: "succeeded" })),
          });
          await seedBatch({ id: "active", status: "running", cases: [{ outcome: "failed" }] });
          const result = await service.readSummary(scope, [suiteId]);
          expect(result.items).toEqual([
            {
              suiteId,
              executionCount: 3,
              completedExecutionCount: 2,
              averagePassRate: 75,
              averagePassedCases: 2.5,
            },
          ]);
        });
      });

      it("includes time boundaries, exception and cancellation results while excluding other scopes and diagnostic reruns", async () => {
        await withHarness(adapter, async ({ seedBatch, service, suiteId }) => {
          await seedBatch({
            id: "lower-boundary",
            createdAt: WINDOW_START,
            status: "failed",
            cases: [{ outcome: "succeeded" }, { outcome: "timed_out" }],
          });
          await seedBatch({
            id: "upper-boundary",
            createdAt: NOW,
            status: "cancelled",
            cases: [{ outcome: "cancelled" }],
          });
          for (const excluded of [
            { id: "old", createdAt: "2026-08-29T11:59:59.999Z" },
            { id: "future", createdAt: "2026-09-05T12:00:00.001Z" },
            { id: "other-project", projectId: "other-project" },
            { id: "other-version", projectVersionId: "other-version" },
            { id: "other-suite", suiteId: "other-suite" },
            { id: "diagnostic", kind: "case_log_rerun" as const },
          ])
            await seedBatch({ ...excluded, cases: [{ outcome: "succeeded" }] });
          expect((await service.readSummary(scope, [suiteId])).items).toEqual([
            {
              suiteId,
              executionCount: 2,
              completedExecutionCount: 2,
              averagePassRate: 25,
              averagePassedCases: 0.5,
            },
          ]);
        });
      });

      it("preserves successful earlier attempts and agrees with execution history after retries", async () => {
        await withHarness(adapter, async ({ seedBatch, service, suiteId }) => {
          await seedBatch({
            id: "retried",
            cases: [
              { outcome: "failed", attempts: ["succeeded", "failed"] },
              { outcome: "succeeded", attempts: ["failed", "succeeded", "succeeded"] },
              { outcome: "failed", attempts: ["failed", "failed"] },
            ],
          });
          const summary = await service.readSummary(scope, [suiteId]);
          const history = await service.readRecentExecutions(suiteId, scope);
          expect(summary.items[0]?.averagePassedCases).toBe(2);
          expect(summary.items[0]?.averagePassRate).toBeCloseTo(200 / 3);
          expect(history.items[0]).toMatchObject({ totalRuns: 3, succeededRuns: 2, failedRuns: 1 });
        });
      });

      it("returns null averages for empty histories, but zero for real all-failed batches", async () => {
        await withHarness(adapter, async ({ seedBatch, service, suiteId }) => {
          expect((await service.readSummary(scope, [suiteId])).items[0]).toMatchObject({
            executionCount: 0,
            averagePassRate: null,
            averagePassedCases: null,
          });
          expect((await service.readRecentExecutions(suiteId, scope)).items).toEqual([]);
          await seedBatch({ id: "failed", cases: [{ outcome: "failed" }] });
          expect((await service.readSummary(scope, [suiteId])).items[0]).toMatchObject({
            executionCount: 1,
            averagePassRate: 0,
            averagePassedCases: 0,
          });
        });
      });

      it("returns the latest ten scoped records in stable order, including final-failure reruns", async () => {
        await withHarness(adapter, async ({ seedBatch, service, suiteId }) => {
          const ids: string[] = [];
          for (let index = 0; index < 12; index += 1) {
            ids.push(
              await seedBatch({
                id: `recent-${String(index).padStart(2, "0")}`,
                kind: index === 11 ? "final_failure_rerun" : "standard",
              }),
            );
          }
          await seedBatch({ id: "zz-diagnostic", kind: "case_log_rerun" });
          await seedBatch({ id: "zz-project", projectId: "other-project" });
          await seedBatch({ id: "zz-version", projectVersionId: "other-version" });
          const result = await service.readRecentExecutions(suiteId, scope);
          const newestFirst = [...ids].reverse();
          expect(result.items.map((batch) => batch.id)).toEqual(newestFirst.slice(0, 10));
          expect(result.items[0]?.kind).toBe("final_failure_rerun");
          expect(result.items[0]).not.toHaveProperty("environmentVariables");
          expect(result.nextCursor).toBeTruthy();
          const older = await service.readRecentExecutions(suiteId, {
            ...scope,
            cursor: result.nextCursor,
          });
          expect(older.items.map((batch) => batch.id)).toEqual(newestFirst.slice(10));
          expect(older.nextCursor).toBeUndefined();
        });
      });

      it("reads the latest trigger for one suite and keeps execution history after plan deletion", async () => {
        await withHarness(adapter, async ({ schedules, seedBatch, service, suiteId }) => {
          expect(await schedules.findScheduleBySuite(suiteId)).toBeNull();
          const batchId = await seedBatch({ id: "scheduled" });
          let schedule = await schedules.upsertSchedule({
            id: `schedule-${suiteId}`,
            suiteId,
            projectId: scope.projectId,
            cronExpression: "0 12 * * *",
            timeZone: "UTC",
            missedRunPolicy: "run-once",
            enabled: true,
            nextTriggerAt: NOW,
            revision: 1,
            createdAt: NOW,
            updatedAt: NOW,
          });
          for (const [index, status] of (["created", "skipped", "failed"] as const).entries()) {
            const scheduledFor = schedule.nextTriggerAt;
            const nextTriggerAt = `2026-09-0${6 + index}T12:00:00.000Z`;
            const claimId = `claim-${suiteId}-${index}`;
            expect(
              await schedules.claimScheduleTrigger({
                scheduleId: schedule.id,
                scheduledFor,
                claimId,
                claimedAt: scheduledFor,
                leaseExpiresAt: scheduledFor.replace("12:00:", "12:01:"),
              }),
            ).toBe(true);
            expect(
              await schedules.completeScheduleTrigger({
                scheduleId: schedule.id,
                scheduledFor,
                claimId,
                status,
                nextTriggerAt,
                ...(status === "created" ? { batchId } : {}),
                recordedAt: scheduledFor,
              }),
            ).toBe(true);
            const latest = await schedules.findScheduleBySuite(suiteId);
            expect(latest).toMatchObject({
              lastTriggerAt: scheduledFor,
              lastTriggerStatus: status,
              nextTriggerAt,
            });
            expect(latest?.lastBatchId).toBe(status === "created" ? batchId : undefined);
            expect(latest).toEqual(
              (await schedules.listSchedules([scope.projectId])).find(
                (entry) => entry.suiteId === suiteId,
              ),
            );
            schedule = latest!;
          }
          const paused = await schedules.upsertSchedule(
            { ...schedule, enabled: false, revision: schedule.revision + 1 },
            schedule.revision,
          );
          expect(await schedules.findScheduleBySuite(suiteId)).toMatchObject({
            enabled: false,
            lastTriggerStatus: "failed",
          });
          await schedules.deleteSchedule(paused.id, paused.revision);
          expect(await schedules.findScheduleBySuite(suiteId)).toBeNull();
          expect(
            (await service.readRecentExecutions(suiteId, scope)).items.map((entry) => entry.id),
          ).toEqual([batchId]);
        });
      });
    },
  );
}

async function withHarness(
  adapter: Adapter,
  run: (harness: Awaited<ReturnType<typeof createHarness>>) => Promise<void>,
) {
  const harness = await createHarness(adapter);
  try {
    await run(harness);
  } finally {
    await harness.dispose();
  }
}

async function createHarness(adapter: Adapter) {
  const directory =
    adapter === "SQLite" ? await mkdtemp(join(tmpdir(), "autoforge-suite-activity-")) : undefined;
  const sqlite = directory
    ? createSqliteDatabase({
        databasePath: join(directory, "platform.sqlite"),
        migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
      })
    : undefined;
  const postgres =
    adapter === "PostgreSQL"
      ? createPostgresDatabase({
          connectionString: connectionString!,
          migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
          poolMax: 2,
        })
      : undefined;
  await postgres?.ready;
  const suffix = randomUUID();
  const suiteId = `activity-suite-${suffix}`;
  const runnerId = `activity-runner-${suffix}`;
  const otherProjectId = `activity-other-project-${suffix}`;
  const otherProject = {
    id: otherProjectId,
    slug: otherProjectId,
    name: "Other activity project",
    createdAt: NOW,
    updatedAt: NOW,
  };
  if (sqlite) sqlite.db.insert(projects).values(otherProject).run();
  else await postgres!.db.insert(pgProjects).values(otherProject);
  const suiteRepository = sqlite
    ? new SqliteCaseSuiteRepository(sqlite)
    : new PostgresCaseSuiteRepository(postgres!);
  const repository = sqlite
    ? new SqliteCaseSuiteActivityRepository(sqlite)
    : new PostgresCaseSuiteActivityRepository(postgres!);
  const batches = sqlite
    ? new SqliteRunBatchRepository(sqlite)
    : new PostgresRunBatchRepository(postgres!);
  const schedules = sqlite
    ? new SqlitePlatformOperationsRepository(sqlite)
    : new PostgresPlatformOperationsRepository(postgres!);
  const service = new CaseSuiteActivityService(repository, suiteRepository, batches, {
    now: () => new Date(NOW),
  });
  await suiteRepository.create({
    id: suiteId,
    name: "Activity suite",
    policy: { ...defaultCaseSuiteExecutionPolicy, projectVersionId: scope.projectVersionId },
    createdAt: NOW,
  });
  const runner = {
    id: runnerId,
    credentialHash: runnerId,
    name: "Activity runner",
    disabled: false,
    os: "linux",
    architecture: "amd64",
    agentVersion: "0.2.2",
    protocolVersion: 1,
    labelsJson: "{}",
    maxConcurrency: 1,
    busySlots: 0,
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
  if (sqlite) sqlite.db.insert(runners).values(runner).run();
  else await postgres!.db.insert(pgRunners).values(runner);
  const batchIds: string[] = [];
  return {
    suiteId,
    service,
    schedules,
    async seedBatch(input: BatchFixture): Promise<string> {
      const id = `${suffix}-${input.id}`;
      batchIds.push(id);
      const cases = input.cases ?? [{ outcome: "failed" as const }];
      const record = {
        id,
        suiteId: input.suiteId ?? suiteId,
        suiteName: "Activity suite",
        suiteVersion: 1,
        sequenceNumber: batchIds.length,
        batchKind: input.kind ?? "standard",
        status: input.status ?? "succeeded",
        projectId:
          input.projectId === "other-project"
            ? otherProjectId
            : (input.projectId ?? scope.projectId),
        policyJson: JSON.stringify({
          projectVersionId: input.projectVersionId ?? scope.projectVersionId,
          executor: "testng",
          concurrency: 1,
          runnerLabels: [],
          artifactPatterns: [],
        }),
        retryLimit: 2,
        retryMode: "round" as const,
        currentRound: 3,
        environmentJson: "[]",
        totalRuns: cases.length,
        scheduledFor: input.createdAt ?? NOW,
        createdAt: input.createdAt ?? NOW,
        updatedAt: input.createdAt ?? NOW,
      };
      if (sqlite) sqlite.db.insert(runBatches).values(record).run();
      else await postgres!.db.insert(pgRunBatches).values(record);
      for (const [index, entry] of cases.entries()) {
        const runId = `${id}-run-${index}`;
        const runRecord = {
          id: runId,
          batchId: id,
          caseDefinitionId: `case-${index}`,
          caseVersion: 1,
          displayName: `Case ${index}`,
          className: `com.example.Case${index}`,
          status: entry.outcome === "timed_out" ? ("failed" as const) : entry.outcome,
          terminalOutcome: entry.outcome,
          attemptCount: entry.attempts?.length ?? 0,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        };
        if (sqlite) sqlite.db.insert(executionRuns).values(runRecord).run();
        else await postgres!.db.insert(pgExecutionRuns).values(runRecord);
        for (const [attemptIndex, outcome] of (entry.attempts ?? []).entries()) {
          const attempt = {
            id: `${runId}-attempt-${attemptIndex}`,
            executionRunId: runId,
            runnerId,
            attemptNumber: attemptIndex + 1,
            status: outcome,
            outcome,
            schedulingScore: 1,
            createdAt: record.createdAt,
            finishedAt: record.updatedAt,
          };
          if (sqlite) sqlite.db.insert(runAttempts).values(attempt).run();
          else await postgres!.db.insert(pgRunAttempts).values(attempt);
        }
      }
      return id;
    },
    async dispose() {
      if (sqlite) sqlite.close();
      if (postgres) {
        try {
          if (batchIds.length > 0)
            await postgres.db.delete(pgRunBatches).where(inArray(pgRunBatches.id, batchIds));
          await postgres.db.delete(pgCaseSuites).where(eq(pgCaseSuites.id, suiteId));
          await postgres.db.delete(pgRunners).where(eq(pgRunners.id, runnerId));
          await postgres.db.delete(pgProjects).where(eq(pgProjects.id, otherProjectId));
        } finally {
          await postgres.close();
        }
      }
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}
