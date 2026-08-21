import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAttemptLogStore } from "../src/attempt-log-store";
import { createSqliteDatabase } from "../src/database";
import { SqlitePlatformOperationsRepository } from "../src/sqlite-platform-operations";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite platform operations", () => {
  it("manages scoped service credentials without storing raw tokens", async () => {
    const { handle, repository } = fixture();
    try {
      const account = await repository.createServiceAccount({
        id: "account-1",
        name: "Build Bot",
        description: "offline automation",
        status: "active",
        systemPermissions: ["run.read"],
        projectPermissions: { "project-1": ["run.create"] },
        createdBy: "user-1",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
        revision: 1,
      });
      const raw = `af_api_${randomBytes(32).toString("base64url")}`;
      await repository.createApiToken({
        id: "token-1",
        serviceAccountId: account.id,
        name: "CI",
        prefix: raw.slice(0, 12),
        scopes: ["run.read", "run.create"],
        expiresAt: "2026-09-11T00:00:00.000Z",
        createdAt: "2026-08-11T00:00:00.000Z",
        tokenHash: "hash-1",
      });

      const authenticated = await repository.authenticateApiToken({
        tokenHash: "hash-1",
        usedAt: "2026-08-11T01:00:00.000Z",
      });
      expect(authenticated?.effectiveScopes).toEqual(["run.create", "run.read"]);
      expect(JSON.stringify(await repository.listApiTokens(account.id))).not.toContain(raw);
      await repository.revokeApiToken({
        tokenId: "token-1",
        revokedAt: "2026-08-11T02:00:00.000Z",
      });
      expect(
        await repository.authenticateApiToken({
          tokenHash: "hash-1",
          usedAt: "2026-08-11T03:00:00.000Z",
        }),
      ).toBeNull();
    } finally {
      handle.close();
    }
  });

  it("stores idempotent schedules, notifications and retention policies", async () => {
    const { handle, repository } = fixture();
    try {
      const schedule = await repository.upsertSchedule({
        id: "schedule-1",
        suiteId: "suite-1",
        projectId: "project-1",
        cronExpression: "0 9 * * 1-5",
        timeZone: "Asia/Shanghai",
        missedRunPolicy: "run-once",
        enabled: true,
        nextTriggerAt: "2026-08-12T01:00:00.000Z",
        revision: 1,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
      });
      expect(await repository.listDueSchedules("2026-08-12T01:00:00.000Z", 10)).toHaveLength(1);
      expect(
        await repository.claimScheduleTrigger({
          scheduleId: schedule.id,
          scheduledFor: schedule.nextTriggerAt,
          claimId: "claim-1",
          claimedAt: "2026-08-12T01:00:00.000Z",
          leaseExpiresAt: "2026-08-12T01:01:00.000Z",
        }),
      ).toBe(true);
      expect(
        await repository.claimScheduleTrigger({
          scheduleId: schedule.id,
          scheduledFor: schedule.nextTriggerAt,
          claimId: "claim-2",
          claimedAt: "2026-08-12T01:00:30.000Z",
          leaseExpiresAt: "2026-08-12T01:01:30.000Z",
        }),
      ).toBe(false);
      expect(
        await repository.completeScheduleTrigger({
          scheduleId: schedule.id,
          scheduledFor: schedule.nextTriggerAt,
          claimId: "claim-1",
          status: "created",
          nextTriggerAt: "2026-08-13T01:00:00.000Z",
          recordedAt: "2026-08-12T01:00:00.000Z",
        }),
      ).toBe(true);
      expect(
        await repository.completeScheduleTrigger({
          scheduleId: schedule.id,
          scheduledFor: schedule.nextTriggerAt,
          claimId: "claim-2",
          status: "created",
          nextTriggerAt: "2026-08-13T01:00:00.000Z",
          recordedAt: "2026-08-12T01:00:00.000Z",
        }),
      ).toBe(false);

      expect(
        await repository.claimScheduledLdapSync({
          claimId: "ldap-claim-1",
          now: "2026-08-12T01:00:00.000Z",
          leaseExpiresAt: "2026-08-12T01:05:00.000Z",
        }),
      ).toBe(true);
      expect(
        await repository.claimScheduledLdapSync({
          claimId: "ldap-claim-2",
          now: "2026-08-12T01:01:00.000Z",
          leaseExpiresAt: "2026-08-12T01:06:00.000Z",
        }),
      ).toBe(false);
      expect(
        await repository.completeScheduledLdapSync({
          claimId: "ldap-claim-1",
          nextAt: "2026-08-12T02:00:00.000Z",
          completedAt: "2026-08-12T01:02:00.000Z",
        }),
      ).toBe(true);
      expect(
        await repository.claimScheduledLdapSync({
          claimId: "ldap-claim-3",
          now: "2026-08-12T01:59:59.000Z",
          leaseExpiresAt: "2026-08-12T02:04:59.000Z",
        }),
      ).toBe(false);

      await repository.createNotification({
        id: "notice-1",
        userId: "user-1",
        projectId: "project-1",
        kind: "batch.completed",
        severity: "info",
        title: "批次完成",
        message: "批次已完成。",
        createdAt: "2026-08-12T01:00:00.000Z",
      });
      expect(
        await repository.listNotifications({
          userId: "user-1",
          projectIds: ["project-1"],
          unreadOnly: true,
          limit: 20,
        }),
      ).toMatchObject({ items: [{ id: "notice-1" }] });
      await repository.markNotificationRead({
        notificationId: "notice-1",
        userId: "user-1",
        readAt: "2026-08-12T02:00:00.000Z",
      });

      await repository.ensureRetentionPolicies([
        {
          category: "log",
          retentionDays: 90,
          minimumDays: 7,
          maximumDays: 730,
          updatedAt: "2026-08-11T00:00:00.000Z",
          revision: 1,
        },
      ]);
      expect(await repository.listRetentionPolicies()).toMatchObject([
        { category: "log", retentionDays: 90 },
      ]);
    } finally {
      handle.close();
    }
  });

  it("rebuilds analytics facts idempotently and filters global search by project", async () => {
    const { handle, repository } = fixture();
    try {
      seedCompletedAttempt(handle);
      seedSucceededAttempt(handle);
      expect(await repository.rebuildAnalyticsFacts(100)).toBe(2);
      expect(await repository.rebuildAnalyticsFacts(100)).toBe(0);
      const summary = await repository.readAnalytics({
        filter: { projectId: "project-1" },
        projectIds: ["project-1"],
        generatedAt: "2026-08-11T03:00:00.000Z",
      });
      expect(summary).toMatchObject({
        sampleCount: 2,
        passed: 3,
        failed: 1,
        skipped: 1,
        successRate: 0.6,
        trend: [{ total: 5, passed: 3, failed: 1, skipped: 1 }],
        failures: [
          {
            description: "expected 1 but got 2",
            signature: "expected <n> but got <n>",
            count: 1,
          },
        ],
      });
      expect(summary.failures).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ resultCode: "TESTNG_SUCCEEDED" })]),
      );
      expect(
        await repository.readAnalytics({
          filter: {
            projectId: "project-1",
            projectVersionId: "version-1",
            testStageId: "stage-1",
          },
          projectIds: ["project-1"],
          generatedAt: "2026-08-11T03:00:00.000Z",
        }),
      ).toMatchObject({ sampleCount: 2, passed: 3, failed: 1 });
      expect(
        await repository.readAnalytics({
          filter: { projectId: "project-1", projectVersionId: "version-missing" },
          projectIds: ["project-1"],
          generatedAt: "2026-08-11T03:00:00.000Z",
        }),
      ).toMatchObject({ sampleCount: 0, passed: 0, failed: 0 });

      // 0.8.5 及以前生成过 schema v1 错误事实。读取分析时必须原地重建，不能要求
      // 管理员删除数据库或等待新执行覆盖历史。
      handle.client
        .prepare(
          `UPDATE analytics_facts SET passed=0, failure_signature='TESTNG_SUCCEEDED:passed',
           schema_version=1 WHERE attempt_id='attempt-success'`,
        )
        .run();
      expect(await repository.rebuildAnalyticsFacts(100)).toBe(1);
      expect(
        await repository.readAnalytics({
          filter: { projectId: "project-1" },
          projectIds: ["project-1"],
          generatedAt: "2026-08-11T03:00:00.000Z",
        }),
      ).toMatchObject({ passed: 3, failures: [{ description: "expected 1 but got 2" }] });
      expect(
        (
          await repository.globalSearch({
            query: "example",
            limit: 20,
            projectIds: ["project-1"],
          })
        ).items,
      ).toContainEqual(
        expect.objectContaining({ kind: "case", id: "case-1", projectId: "project-1" }),
      );
      expect(
        await repository.globalSearch({ query: "example", limit: 20, projectIds: ["project-2"] }),
      ).toEqual({ items: [] });
    } finally {
      handle.close();
    }
  });

  it("reports low-cardinality operational counters from authoritative tables", async () => {
    const { handle, attemptLogs, repository } = fixture();
    try {
      seedCompletedAttempt(handle);
      await attemptLogs.appendChunks({
        batchId: "00000000-0000-4000-8000-000000000b01",
        attemptId: "attempt-1",
        receivedAt: "2026-08-11T01:00:00.000Z",
        chunks: [
          {
            stream: "stdout",
            sequence: 0,
            content: "hello",
            recordedAt: "2026-08-11T01:00:00.000Z",
          },
        ],
      });
      handle.client.exec(`
        INSERT INTO attempt_artifacts
          (id,attempt_id,relative_path,media_type,size_bytes,sha256,required,status,object_key,
           created_at,updated_at)
        VALUES ('artifact-metric','attempt-1','report.txt','text/plain',6,'${"c".repeat(64)}',0,
                'uploaded','artifacts/report.txt','2026-08-11T01:00:00.000Z',
                '2026-08-11T01:00:00.000Z');
        INSERT INTO cleanup_jobs
          (id,category,resource_type,resource_id,status,available_at,created_at,updated_at)
        VALUES ('cleanup-pending','artifact','artifact','artifact-metric','pending',
                '2026-08-11T01:00:00.000Z','2026-08-11T01:00:00.000Z',
                '2026-08-11T01:00:00.000Z'),
               ('cleanup-dead','artifact','artifact','artifact-missing','dead_letter',
                '2026-08-11T01:00:00.000Z','2026-08-11T01:00:00.000Z',
                '2026-08-11T01:00:00.000Z');
      `);

      const metrics = await repository.readOperationalMetrics();
      expect(metrics).toMatchObject({
        activeLeases: 0,
        runnerCapacity: 1,
        runnerBusySlots: 0,
        uploadedArtifacts: 1,
        failedAttempts: 1,
        pendingCleanupJobs: 1,
        deadLetterCleanupJobs: 1,
      });
      // 日志字节来自批次文件统计，文件大小包含 SQLite 页面开销。
      expect(metrics.storedLogBytes).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  it("persists analytics exports and their queue dispatch atomically with owner isolation", async () => {
    const { handle, repository } = fixture();
    try {
      const job = await repository.createAnalyticsExportJob({
        job: {
          id: "export-1",
          requestedBy: "user-1",
          filter: { projectId: "project-1" },
          format: "csv",
          status: "queued",
          progressPercent: 0,
          createdAt: "2026-08-11T01:00:00.000Z",
          updatedAt: "2026-08-11T01:00:00.000Z",
        },
        projectIds: ["project-1"],
        idempotencyKey: "export-request-1",
        dispatchJob: {
          schemaVersion: 1,
          messageId: "export-message-1",
          runId: "export-1",
          attempt: 1,
          createdAt: "2026-08-11T01:00:00.000Z",
          priority: 0,
          deduplicationKey: "analytics-export:export-1:1",
          kind: "analytics-export",
          payload: { exportId: "export-1" },
        },
      });
      expect(job.status).toBe("queued");
      expect(
        handle.client
          .prepare("SELECT kind FROM queue_jobs WHERE message_id='export-message-1'")
          .get(),
      ).toEqual({ kind: "analytics-export" });
      await expect(repository.getAnalyticsExportJob("export-1", "user-2")).resolves.toBeNull();

      const claimed = await repository.claimAnalyticsExportJob({
        jobId: "export-1",
        startedAt: "2026-08-11T01:00:01.000Z",
      });
      expect(claimed).toMatchObject({
        projectIds: ["project-1"],
        job: { status: "running", progressPercent: 10 },
      });
      const completed = await repository.updateAnalyticsExportJob({
        jobId: "export-1",
        status: "succeeded",
        progressPercent: 100,
        rowCount: 4,
        sizeBytes: 100,
        sha256: "d".repeat(64),
        objectKey: "tenants/scope/analytics-exports/user-1/export-1.csv",
        fileName: "autoforge-analytics-export-1.csv",
        updatedAt: "2026-08-11T01:00:02.000Z",
        finishedAt: "2026-08-11T01:00:02.000Z",
      });
      expect(completed).toMatchObject({ status: "succeeded", rowCount: 4, sizeBytes: 100 });
      await expect(
        repository.resolveAnalyticsExportObject({ jobId: "export-1", requestedBy: "user-1" }),
      ).resolves.toMatchObject({
        objectKey: "tenants/scope/analytics-exports/user-1/export-1.csv",
        mediaType: "text/csv",
      });
    } finally {
      handle.close();
    }
  });

  it("persists retryable object cleanup before removing retained artifact metadata", async () => {
    const { handle, repository } = fixture();
    try {
      seedCompletedAttempt(handle);
      handle.client.exec(`
        INSERT INTO attempt_artifacts
          (id,attempt_id,relative_path,media_type,size_bytes,sha256,required,status,object_key,created_at,updated_at)
        VALUES ('artifact-1','attempt-1','report.txt','text/plain',6,'${"b".repeat(64)}',0,'uploaded',
                'artifacts/report.txt','2026-08-11T01:00:00.000Z','2026-08-11T01:00:00.000Z')
      `);

      const retained = await repository.executeRetention({
        category: "artifact",
        cutoffAt: "2026-08-12T00:00:00.000Z",
        limit: 10,
        recordedAt: "2026-08-12T00:00:00.000Z",
      });
      expect(retained).toEqual({ deletedRecords: 1, objectKeys: ["artifacts/report.txt"] });
      expect(
        handle.client.prepare("SELECT count(*) AS count FROM attempt_artifacts").get(),
      ).toEqual({ count: 0 });

      const claimed = await repository.claimRetentionCleanupJobs({
        owner: "worker-1",
        now: "2026-08-12T00:00:00.000Z",
        leaseExpiresAt: "2026-08-12T00:01:00.000Z",
        limit: 10,
      });
      expect(claimed).toMatchObject([
        { resourceId: "artifact-1", objectKey: "artifacts/report.txt", attemptCount: 1 },
      ]);
      expect(
        await repository.claimRetentionCleanupJobs({
          owner: "worker-2",
          now: "2026-08-12T00:00:30.000Z",
          leaseExpiresAt: "2026-08-12T00:01:30.000Z",
          limit: 10,
        }),
      ).toEqual([]);
      await repository.completeRetentionCleanupJob({
        id: claimed[0]!.id,
        owner: "worker-1",
        status: "succeeded",
        availableAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:10.000Z",
      });
      expect(
        handle.client
          .prepare("SELECT status FROM cleanup_jobs WHERE resource_id='artifact-1'")
          .get(),
      ).toEqual({ status: "succeeded" });
    } finally {
      handle.close();
    }
  });

  it("previews and executes log retention against per-batch log files", async () => {
    const { handle, attemptLogs, repository } = fixture();
    const batchId = "00000000-0000-4000-8000-000000000b01";
    try {
      seedCompletedAttempt(handle);
      await attemptLogs.appendChunks({
        batchId,
        attemptId: "attempt-1",
        receivedAt: "2026-08-11T01:00:00.000Z",
        chunks: [
          {
            stream: "stdout",
            sequence: 0,
            content: "retained-line",
            recordedAt: "2026-08-11T01:00:00.000Z",
          },
        ],
      });

      const preview = await repository.previewRetention("log", "2026-08-12T00:00:00.000Z");
      expect(preview).toMatchObject({ category: "log", eligibleRecords: 1 });
      expect(preview.eligibleBytes).toBeGreaterThan(0);

      const executed = await repository.executeRetention({
        category: "log",
        cutoffAt: "2026-08-12T00:00:00.000Z",
        limit: 10,
        recordedAt: "2026-08-12T00:00:00.000Z",
      });
      expect(executed).toEqual({ deletedRecords: 1, objectKeys: [] });
      expect(attemptLogs.batchStoreStats([batchId]).get(batchId)).toBe(0);
      // 主库不再保存日志表；结果记录保留。
      expect(
        handle.client
          .prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'attempt_log_chunks'")
          .get(),
      ).toEqual({ count: 0 });
      expect(handle.client.prepare("SELECT count(*) AS count FROM run_attempts").get()).toEqual({
        count: 1,
      });
    } finally {
      handle.close();
    }
  });

  it("removes per-batch log files when execution retention deletes batches", async () => {
    const { handle, attemptLogs, repository } = fixture();
    const batchId = "00000000-0000-4000-8000-000000000b01";
    try {
      seedCompletedAttempt(handle);
      await attemptLogs.appendChunks({
        batchId,
        attemptId: "attempt-1",
        receivedAt: "2026-08-11T01:00:00.000Z",
        chunks: [
          {
            stream: "stdout",
            sequence: 0,
            content: "batch-removal",
            recordedAt: "2026-08-11T01:00:00.000Z",
          },
        ],
      });

      const executed = await repository.executeRetention({
        category: "execution",
        cutoffAt: "2026-08-12T00:00:00.000Z",
        limit: 10,
        recordedAt: "2026-08-12T00:00:00.000Z",
      });
      expect(executed).toEqual({ deletedRecords: 1, objectKeys: [] });
      expect(attemptLogs.batchStoreStats([batchId]).get(batchId)).toBe(0);
      expect(handle.client.prepare("SELECT count(*) AS count FROM run_batches").get()).toEqual({
        count: 0,
      });
    } finally {
      handle.close();
    }
  });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "autoforge-platform-operations-"));
  temporaryDirectories.push(directory);
  const handle = createSqliteDatabase({
    databasePath: join(directory, "autoforge.sqlite"),
    migrationsFolder: resolve("packages/db/drizzle/sqlite"),
  });
  handle.client.exec(`
    INSERT INTO users
      (id,username,normalized_username,display_name,source,status,force_password_change,
       failed_login_attempts,created_at,updated_at,version)
    VALUES ('user-1','admin','admin','Admin','local','active',0,0,
            '2026-08-11T00:00:00.000Z','2026-08-11T00:00:00.000Z',1);
    INSERT INTO projects (id,name,slug,is_default,archived,created_at,updated_at,owner_user_id)
    VALUES ('project-1','Project One','project-one',0,0,
            '2026-08-11T00:00:00.000Z','2026-08-11T00:00:00.000Z','user-1');
    INSERT INTO project_versions
      (id,project_id,name,normalized_name,status,revision,created_at,updated_at)
    VALUES ('version-1','project-1','1.0','1.0','active',1,
            '2026-08-11T00:00:00.000Z','2026-08-11T00:00:00.000Z');
    INSERT INTO test_stages
      (id,project_id,project_version_id,name,normalized_name,description,position,status,revision,
       created_at,updated_at)
    VALUES ('stage-1','project-1','version-1','System','system','',1,'active',1,
            '2026-08-11T00:00:00.000Z','2026-08-11T00:00:00.000Z');
    INSERT INTO case_suites
      (id,project_id,name,description,version,status,enabled,revision,policy_json,
       created_by,updated_by,created_at,updated_at)
    VALUES ('suite-1','project-1','Regression','',1,'active',1,1,'{}','user-1','user-1',
            '2026-08-11T00:00:00.000Z','2026-08-11T00:00:00.000Z');
  `);
  const attemptLogs = createAttemptLogStore(join(directory, "attempt-logs"));
  return {
    handle,
    attemptLogs,
    repository: new SqlitePlatformOperationsRepository(handle, attemptLogs),
  };
}

function seedCompletedAttempt(handle: ReturnType<typeof createSqliteDatabase>) {
  const now = "2026-08-11T01:00:00.000Z";
  handle.client.exec(`
    INSERT INTO case_sources
      (id,project_id,project_version_id,test_stage_id,display_name,original_file_name,object_key,
       sha256,size_bytes,class_count,
       method_count,status,warnings_json,inspection_json,authoritative,lifecycle_status,revision,
       created_at,updated_at)
    VALUES ('source-1','project-1','version-1','stage-1','Example','example.jar','jars/example',
            '${"a".repeat(64)}',10,1,1,
            'ready','[]','{}',1,'active',1,'${now}','${now}');
    INSERT INTO case_definitions
      (id,project_id,project_version_id,test_stage_id,source_id,class_name,package_name,display_name,
       description,tags_json,
       parameters_json,enabled,archived,revision,groups_json,current_version,created_at,updated_at)
    VALUES ('case-1','project-1','version-1','stage-1','source-1','com.example.Test','com.example',
            'Example Test','',
            '[]','{}',1,0,1,'[]',1,'${now}','${now}');
    INSERT INTO runners
      (id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,
       labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,terminal_enabled,
       created_at,updated_at)
    VALUES ('runner-1','hash','Runner',0,0,'linux','amd64','0.2.2',1,'[]','[]',1,0,
            '${now}',0,'${now}','${now}');
    INSERT INTO run_batches
      (id,suite_id,suite_name,suite_version,status,retry_limit,environment_json,
       secret_bindings_json,total_runs,project_id,priority,created_at,updated_at)
    VALUES ('00000000-0000-4000-8000-000000000b01','suite-1','Regression',1,'failed',0,'[]','[]',1,'project-1',0,'${now}','${now}');
    INSERT INTO execution_runs
      (id,batch_id,case_definition_id,case_version,display_name,class_name,parameters_json,status,
       attempt_count,created_at,updated_at)
    VALUES ('run-1','00000000-0000-4000-8000-000000000b01','case-1',1,'Example Test','com.example.Test','{}','failed',1,'${now}','${now}');
    INSERT INTO run_attempts
      (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,created_at,finished_at,
       outcome,result_code,result_summary,duration_ms,testng_result_json)
    VALUES ('attempt-1','run-1','runner-1',1,'failed',1,'${now}','${now}','failed',
            'TEST_FAILURE','expected 1 but got 2',1200,
            '{"total":4,"passed":2,"failed":1,"skipped":1,"configurationFailures":0,"detailsTruncated":true,"suites":[]}');
  `);
}

function seedSucceededAttempt(handle: ReturnType<typeof createSqliteDatabase>) {
  const now = "2026-08-11T01:30:00.000Z";
  handle.client.exec(`
    INSERT INTO run_batches
      (id,suite_id,suite_name,suite_version,status,retry_limit,environment_json,
       secret_bindings_json,total_runs,project_id,priority,created_at,updated_at)
    VALUES ('00000000-0000-4000-8000-000000000b02','suite-1','Regression',1,'succeeded',0,
            '[]','[]',1,'project-1',0,'${now}','${now}');
    INSERT INTO execution_runs
      (id,batch_id,case_definition_id,case_version,display_name,class_name,parameters_json,status,
       attempt_count,created_at,updated_at)
    VALUES ('run-success','00000000-0000-4000-8000-000000000b02','case-1',1,'Example Test',
            'com.example.Test','{}','succeeded',1,'${now}','${now}');
    INSERT INTO run_attempts
      (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,created_at,finished_at,
       outcome,result_code,result_summary,duration_ms,testng_result_json)
    VALUES ('attempt-success','run-success','runner-1',1,'succeeded',1,'${now}','${now}',
            'succeeded','TESTNG_SUCCEEDED','TestNG passed 1 test method(s).',800,
            '{"total":1,"passed":1,"failed":0,"skipped":0,"configurationFailures":0,"detailsTruncated":true,"suites":[]}');
  `);
}
